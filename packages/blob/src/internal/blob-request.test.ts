import type { TestHttpResponse } from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import {
  ApiForbidden,
  ApiNetworkFailure,
  ApiRateLimited,
  ApiServerError,
  ApiUnexpectedResponse,
  OidcTokenUnavailable,
  VercelApiError,
  VercelOidc,
} from "@panorama-industries/effect-vercel-core";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import { Context, Effect, Exit, Fiber, Layer, Option, Redacted, Ref, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import { TestClock } from "effect/testing";

import type { BlobConfig } from "../contracts/blob-config.ts";
import type { UploadProgress } from "../contracts/blob-domain.ts";
import type { BlobRequestSettings } from "./blob-request.ts";

import { BlobAuth } from "../contracts/blob-config.ts";
import { PresignedUrlPayload, PutBlobResult, StoreId } from "../contracts/blob-domain.ts";
import {
  BlobNotFound,
  BlobStoreNotFound,
  BlobStoreSuspended,
  BlobStoreUnavailable,
  BlobUploadRejected,
  ContentTypeNotAllowed,
} from "../contracts/blob-errors.ts";
import {
  BlobRequestAuth,
  blobRequester,
  chunkBytes,
  progressChunkSize,
  serverBlobAuth,
  supportsRequestStreams,
  uploadProgressThrottle,
} from "./blob-request.ts";
import { defaultBlobBaseUrl } from "./urls.ts";
import { PutBlobResponse } from "./wire.ts";

const Success = Schema.Struct({ success: Schema.Boolean });

const bearer = (token = "123", storeId = "store1") =>
  Effect.succeed(BlobRequestAuth.Bearer({ token: Redacted.make(token), storeId }));

const requesterWith = (overrides: Partial<Omit<BlobRequestSettings, "httpClient">> = {}) =>
  Effect.gen(function* () {
    const server = yield* TestHttpServer;
    const httpClient = yield* HttpClient.HttpClient;
    return blobRequester({
      httpClient,
      apiUrl: new URL(`${server.url}/api/blob`),
      apiVersion: "13",
      retries: 10,
      sendContentLength: false,
      headers: {},
      ...overrides,
    });
  });

const TestLayer = Layer.mergeAll(TestHttpServerLive(), FetchHttpClient.layer);

/** Fails the first `failures` requests with a transport error before they reach the server. */
const failingTransport = (failures: number) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const remaining = yield* Ref.make(failures);
      return HttpClient.mapRequestEffect(client, (request) =>
        Effect.flatMap(
          Ref.getAndUpdate(remaining, (n) => n - 1),
          (left) =>
            left > 0
              ? Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request, description: "reset" }),
                  }),
                )
              : Effect.succeed(request),
        ),
      );
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

const requests = Effect.flatMap(Effect.service(TestHttpServer), (server) => server.requests);

const enqueue = (...responses: ReadonlyArray<TestHttpResponse>) =>
  Effect.flatMap(Effect.service(TestHttpServer), (server) => server.enqueue(...responses));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const errorBody = (status: number, code: string, message?: string) =>
  json(status, { error: { code, ...(message === undefined ? {} : { message }) } });

const ok = json(200, { success: true });

/** Runs `effect` while advancing the test clock, so retry backoff does not wait in real time. */
const runWithClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("1 minute");
      yield* TestClock.withLive(Effect.sleep("2 millis"));
    }
    return yield* Fiber.await(fiber);
  });

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
  assert.isDefined(error);
  return (error as { readonly error: E }).error;
};

const recorder = Effect.gen(function* () {
  const events = yield* Ref.make<ReadonlyArray<UploadProgress>>([]);
  return {
    events: Ref.get(events),
    onUploadProgress: (progress: UploadProgress) => Ref.update(events, (all) => [...all, progress]),
  };
});

const pct = (loaded: number, total: number) => Number(((loaded / total) * 100).toFixed(2));

describe("blobRequester call", () => {
  it.effect("sends the SDK's protocol headers and decodes the JSON response", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      const result = yield* requester.call({
        operation: "Test.call",
        method: "POST",
        path: "/method",
        auth: bearer(),
        body: JSON.stringify({ foo: "bar" }),
        response: Success,
      });
      assert.deepStrictEqual(result, { success: true });
      const [request] = yield* requests;
      assert.isDefined(request);
      assert.strictEqual(request!.method, "POST");
      assert.strictEqual(request!.url, "/api/blob/method");
      assert.strictEqual(request!.text, '{"foo":"bar"}');
      assert.strictEqual(request!.headers.authorization, "Bearer 123");
      assert.strictEqual(request!.headers["x-api-blob-request-attempt"], "0");
      assert.strictEqual(request!.headers["x-api-version"], "13");
      assert.strictEqual(request!.headers["x-vercel-blob-store-id"], "store1");
      assert.match(request!.headers["x-api-blob-request-id"]!, /^store1:\d+:[a-f0-9]+$/);
      assert.notProperty(request!.headers, "x-content-length");
      assert.notProperty(request!.headers, "traceparent");
      assert.notProperty(request!.headers, "b3");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("uses the current time in the request id", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_123);
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      yield* requester.call({ operation: "Test.call", method: "GET", path: "", auth: bearer() });
      const [request] = yield* requests;
      assert.match(request!.headers["x-api-blob-request-id"]!, /^store1:1700000000123:[a-f0-9]+$/);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("appends the path as given: no slash before a query, trailing slashes trimmed", () =>
    Effect.gen(function* () {
      yield* enqueue(ok, ok);
      const server = yield* TestHttpServer;
      const requester = yield* requesterWith({ apiUrl: new URL(`${server.url}/api/blob/`) });
      const query = new URLSearchParams({ url: "https://s.public.blob.vercel-storage.com/a b" });
      yield* requester.call({
        operation: "Test.head",
        method: "GET",
        path: `?${query.toString()}`,
        auth: bearer(),
      });
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: `/?${new URLSearchParams({ pathname: "folder/a+b.txt" }).toString()}`,
        auth: bearer(),
      });
      const [head, put] = yield* requests;
      assert.strictEqual(
        head!.url,
        "/api/blob?url=https%3A%2F%2Fs.public.blob.vercel-storage.com%2Fa+b",
      );
      assert.strictEqual(put!.url, "/api/blob/?pathname=folder%2Fa%2Bb.txt");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends the settings' headers, then the call's headers, which override everything", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith({
        headers: { "x-proxy-through-alternative-api": "1", "x-api-version": "99" },
      });
      yield* requester.call({
        operation: "Test.call",
        method: "PUT",
        path: "/",
        auth: bearer(),
        headers: { authorization: "Bearer override", "x-vercel-blob-access": "public" },
      });
      const [request] = yield* requests;
      assert.strictEqual(request!.headers["x-proxy-through-alternative-api"], "1");
      assert.strictEqual(request!.headers["x-api-version"], "99");
      assert.strictEqual(request!.headers.authorization, "Bearer override");
      assert.strictEqual(request!.headers["x-vercel-blob-access"], "public");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends x-content-length as the body's byte length when configured", () =>
    Effect.gen(function* () {
      yield* enqueue(ok, ok);
      const requester = yield* requesterWith({ sendContentLength: true });
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: "héllo",
      });
      yield* requester.call({ operation: "Test.get", method: "GET", path: "", auth: bearer() });
      const [put, get] = yield* requests;
      assert.strictEqual(put!.headers["x-content-length"], "6");
      assert.strictEqual(get!.headers["x-content-length"], "0");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends a JSON body with content-type application/json", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      yield* requester.call({
        operation: "Test.del",
        method: "POST",
        path: "/delete",
        auth: bearer(),
        json: { urls: ["a", "b"] },
      });
      const [request] = yield* requests;
      assert.strictEqual(request!.headers["content-type"], "application/json");
      assert.strictEqual(request!.text, '{"urls":["a","b"]}');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends bytes, Blobs and streams", () =>
    Effect.gen(function* () {
      yield* enqueue(ok, ok, ok);
      const requester = yield* requesterWith();
      const put = (body: Uint8Array | Blob | Stream.Stream<Uint8Array>) =>
        requester.call({ operation: "Test.put", method: "PUT", path: "/", auth: bearer(), body });
      yield* put(new TextEncoder().encode("bytes"));
      yield* put(new Blob(["blob"], { type: "text/plain" }));
      yield* put(Stream.make(new TextEncoder().encode("str"), new TextEncoder().encode("eam")));
      const [bytes, blob, stream] = yield* requests;
      assert.strictEqual(bytes!.text, "bytes");
      assert.strictEqual(blob!.text, "blob");
      assert.strictEqual(stream!.text, "stream");
      assert.notProperty(stream!.headers, "content-type");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("authenticates presigned calls with the payload's query parameters only", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      const payload = new PresignedUrlPayload({
        delegationToken: "deleg.ation",
        signature: "sig/+=",
        params: { "vercel-blob-operation": "put", "vercel-blob-valid-until": "1700000000000" },
      });
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: `/?${new URLSearchParams({ pathname: "a.txt" }).toString()}`,
        auth: Effect.succeed(BlobRequestAuth.Presigned({ payload, storeId: "presignedStore" })),
      });
      const [request] = yield* requests;
      assert.notProperty(request!.headers, "authorization");
      assert.strictEqual(request!.headers["x-vercel-blob-store-id"], "presignedStore");
      const url = new URL(request!.url, "http://localhost");
      assert.deepStrictEqual(
        [...url.searchParams.entries()],
        [
          ["pathname", "a.txt"],
          ["vercel-blob-operation", "put"],
          ["vercel-blob-valid-until", "1700000000000"],
          ["vercel-blob-delegation", "deleg.ation"],
          ["vercel-blob-signature", "sig/+="],
        ],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("decodes responses into contract classes", () =>
    Effect.gen(function* () {
      yield* enqueue(
        json(200, {
          url: "https://s.public.blob.vercel-storage.com/a.txt",
          downloadUrl: "https://s.public.blob.vercel-storage.com/a.txt?download=1",
          pathname: "a.txt",
          contentType: "text/plain",
          contentDisposition: 'inline; filename="a.txt"',
          etag: '"e"',
        }),
      );
      const requester = yield* requesterWith();
      const result = yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: "a",
        response: PutBlobResponse,
      });
      assert.instanceOf(result, PutBlobResult);
      assert.strictEqual(result.pathname, "a.txt");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores the response body when no schema is given", () =>
    Effect.gen(function* () {
      yield* enqueue({ status: 200, body: "" });
      const requester = yield* requesterWith();
      const result = yield* requester.call({
        operation: "Test.del",
        method: "POST",
        path: "/delete",
        auth: bearer(),
      });
      assert.isUndefined(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "reports a body that is not JSON or does not decode as ApiUnexpectedResponse, once",
    () =>
      Effect.gen(function* () {
        yield* enqueue({ status: 200, body: "not json" }, json(200, { success: "yes" }));
        const requester = yield* requesterWith();
        const call = requester.call({
          operation: "Test.call",
          method: "GET",
          path: "",
          auth: bearer(),
          response: Success,
        });
        const notJson = yield* Effect.flip(call);
        assert.instanceOf(notJson, VercelApiError);
        assert.instanceOf((notJson as VercelApiError).reason, ApiUnexpectedResponse);
        const wrongShape = yield* Effect.flip(call);
        assert.instanceOf((wrongShape as VercelApiError).reason, ApiUnexpectedResponse);
        assert.strictEqual((yield* requests).length, 2);
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe("blobRequester retries", () => {
  it.effect.each([
    [400, "unknown_error"],
    [500, "service_unavailable"],
    [500, "internal_server_error"],
  ] as const)("retries a '%s %s' error response", ([status, code]) =>
    Effect.gen(function* () {
      yield* enqueue(errorBody(status, code), errorBody(status, code));
      const requester = yield* requesterWith({ retries: 1 });
      const exit = yield* runWithClock(
        requester.call({ operation: "Test.call", method: "GET", path: "/api", auth: bearer() }),
      );
      const error = failureOf(exit);
      assert.instanceOf(error, VercelApiError);
      assert.deepStrictEqual((error as VercelApiError).errorCode, Option.some(code));
      const all = yield* requests;
      assert.strictEqual(all.length, 2);
      assert.deepStrictEqual(
        all.map((request) => request.headers["x-api-blob-request-attempt"]),
        ["0", "1"],
      );
      assert.strictEqual(
        all[0]!.headers["x-api-blob-request-id"],
        all[1]!.headers["x-api-blob-request-id"],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("retries a response whose body is not JSON, then succeeds", () =>
    Effect.gen(function* () {
      yield* enqueue({ status: 502, body: "<html>Bad gateway</html>" }, ok);
      const requester = yield* requesterWith({ retries: 3 });
      const exit = yield* runWithClock(
        requester.call({
          operation: "Test.call",
          method: "PUT",
          path: "/",
          auth: bearer(),
          body: "resent",
          response: Success,
        }),
      );
      assert.deepStrictEqual(exit, Exit.succeed({ success: true }));
      const all = yield* requests;
      assert.deepStrictEqual(
        all.map((request) => [request.headers["x-api-blob-request-attempt"], request.text]),
        [
          ["0", "resent"],
          ["1", "resent"],
        ],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("gives up after `retries` retries", () =>
    Effect.gen(function* () {
      yield* (yield* TestHttpServer).setHandler(() => errorBody(500, "unknown_error"));
      const requester = yield* requesterWith({ retries: 3 });
      const exit = yield* runWithClock(
        requester.call({ operation: "Test.call", method: "GET", path: "", auth: bearer() }),
      );
      assert.instanceOf((failureOf(exit) as VercelApiError).reason, ApiServerError);
      assert.deepStrictEqual(
        (yield* requests).map((request) => request.headers["x-api-blob-request-attempt"]),
        ["0", "1", "2", "3"],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("makes a single attempt with zero retries", () =>
    Effect.gen(function* () {
      yield* enqueue(errorBody(500, "unknown_error"));
      const requester = yield* requesterWith({ retries: 0 });
      yield* Effect.flip(
        requester.call({ operation: "Test.call", method: "GET", path: "", auth: bearer() }),
      );
      assert.strictEqual((yield* requests).length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("retries network failures", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith({ retries: 2 });
      const exit = yield* runWithClock(
        requester.call({
          operation: "Test.call",
          method: "GET",
          path: "",
          auth: bearer(),
          response: Success,
        }),
      );
      assert.deepStrictEqual(exit, Exit.succeed({ success: true }));
      const [request] = yield* requests;
      assert.strictEqual(request!.headers["x-api-blob-request-attempt"], "2");
    }).pipe(Effect.provide(Layer.mergeAll(TestHttpServerLive(), failingTransport(2)))),
  );

  it.effect("reports a persistent network failure as ApiNetworkFailure", () =>
    Effect.gen(function* () {
      const requester = yield* requesterWith({ retries: 1 });
      const exit = yield* runWithClock(
        requester.call({ operation: "Test.call", method: "GET", path: "", auth: bearer() }),
      );
      const error = failureOf(exit) as VercelApiError;
      assert.instanceOf(error.reason, ApiNetworkFailure);
      assert.strictEqual(error.operation, "Test.call");
    }).pipe(Effect.provide(Layer.mergeAll(TestHttpServerLive(), failingTransport(5)))),
  );

  const notRetried = [
    [300, "store_suspended", undefined, BlobStoreUnavailable],
    [400, "forbidden", undefined, VercelApiError],
    [400, "forbidden", '"contentType" text/plain is not allowed', BlobUploadRejected],
    [500, "not_found", undefined, BlobNotFound],
    [400, "bad_request", undefined, VercelApiError],
    [404, "store_not_found", undefined, BlobStoreUnavailable],
    [403, "not_allowed", undefined, VercelApiError],
    [429, "rate_limited", undefined, VercelApiError],
  ] as const;

  it.effect.each(notRetried)(
    "does not retry a '%s %s' error response",
    ([status, code, message, errorClass]) =>
      Effect.gen(function* () {
        yield* enqueue({
          ...errorBody(status, code, message),
          headers: { "content-type": "application/json", "retry-after": "1" },
        });
        const requester = yield* requesterWith();
        const error = yield* Effect.flip(
          requester.call({ operation: "Test.call", method: "GET", path: "/api", auth: bearer() }),
        );
        assert.instanceOf(error, errorClass as new (...args: ReadonlyArray<never>) => unknown);
        assert.strictEqual((yield* requests).length, 1);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("maps error responses with their details", () =>
    Effect.gen(function* () {
      yield* enqueue(
        errorBody(403, "store_suspended"),
        errorBody(403, "store_not_found"),
        errorBody(400, "forbidden", '"contentType" text/plain is not allowed'),
        errorBody(404, "not_found"),
        errorBody(400, "forbidden"),
        json(429, { error: { code: "rate_limited" } }, { "retry-after": "7" }),
      );
      const requester = yield* requesterWith();
      const fail = (locator?: string) =>
        Effect.flip(
          requester.call({
            operation: "BlobStore.head",
            method: "GET",
            path: "?url=a.txt",
            auth: bearer(),
            locator,
          }),
        );
      const suspended = (yield* fail()) as BlobStoreUnavailable;
      assert.instanceOf(suspended.reason, BlobStoreSuspended);
      const missingStore = (yield* fail()) as BlobStoreUnavailable;
      assert.instanceOf(missingStore.reason, BlobStoreNotFound);
      const rejected = (yield* fail()) as BlobUploadRejected;
      assert.instanceOf(rejected.reason, ContentTypeNotAllowed);
      const notFound = (yield* fail("a.txt")) as BlobNotFound;
      assert.strictEqual(notFound.locator, "a.txt");
      const forbidden = (yield* fail()) as VercelApiError;
      assert.instanceOf(forbidden.reason, ApiForbidden);
      assert.strictEqual(forbidden.operation, "BlobStore.head");
      const limited = (yield* fail()) as VercelApiError;
      assert.instanceOf(limited.reason, ApiRateLimited);
      assert.deepStrictEqual(limited.errorCode, Option.some("rate_limited"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports undeclared domain errors as VercelApiError", () =>
    Effect.gen(function* () {
      yield* enqueue(errorBody(404, "not_found"));
      const requester = yield* requesterWith();
      const error = yield* Effect.flip(
        requester.call({
          operation: "BlobStore.list",
          method: "GET",
          path: "",
          auth: bearer(),
          domainErrors: ["BlobStoreUnavailable"],
        }),
      );
      assert.instanceOf(error, VercelApiError);
      assert.deepStrictEqual((error as VercelApiError).errorCode, Option.some("not_found"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends a stream body once, even when the error is retryable", () =>
    Effect.gen(function* () {
      yield* enqueue(errorBody(500, "unknown_error"), ok);
      const requester = yield* requesterWith({ retries: 3 });
      const error = yield* Effect.flip(
        requester.call({
          operation: "Test.put",
          method: "PUT",
          path: "/",
          auth: bearer(),
          body: Stream.make(new TextEncoder().encode("once")),
        }),
      );
      assert.instanceOf(error, VercelApiError);
      const all = yield* requests;
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0]!.text, "once");
    }).pipe(Effect.provide(TestLayer)),
  );
});

class BodyFailed extends Schema.TaggedError<BodyFailed>()("BodyFailed", {}) {}

class Chunks extends Context.Service<Chunks, ReadonlyArray<string>>()("test/Chunks") {}

describe("blobRequester stream bodies", () => {
  it.effect("fails with the body stream's own error", () =>
    Effect.gen(function* () {
      yield* (yield* TestHttpServer).setHandler(() => ok);
      const requester = yield* requesterWith();
      const error = yield* Effect.flip(
        requester.call({
          operation: "Test.put",
          method: "PUT",
          path: "/",
          auth: bearer(),
          body: Stream.concat(
            Stream.make(new TextEncoder().encode("partial")),
            Stream.fail(new BodyFailed()),
          ),
        }),
      );
      assert.instanceOf(error, BodyFailed);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("provides the body stream's requirements", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      const body = Stream.unwrap(
        Effect.map(Effect.service(Chunks), (chunks) =>
          Stream.fromIterable(chunks.map((chunk) => new TextEncoder().encode(chunk))),
        ),
      );
      yield* requester
        .call({ operation: "Test.put", method: "PUT", path: "/", auth: bearer(), body })
        .pipe(Effect.provideService(Chunks, ["from ", "context"]));
      const [request] = yield* requests;
      assert.strictEqual(request!.text, "from context");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("upload progress", () => {
  const size = 3 * progressChunkSize + 10;
  const bytes = new Uint8Array(size).map((_, index) => index % 251);

  it.effect("reports 0 %, every 64 KiB chunk below 100 %, then 100 % after the response", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      const { events, onUploadProgress } = yield* recorder;
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: bytes,
        onUploadProgress,
      });
      const chunk = (n: number) => ({
        loaded: n * progressChunkSize,
        total: size,
        percentage: pct(n * progressChunkSize, size),
      });
      assert.deepStrictEqual(yield* events, [
        { loaded: 0, total: size, percentage: 0 },
        chunk(1),
        chunk(2),
        chunk(3),
        { loaded: size, total: size, percentage: 100 },
      ]);
      const [request] = yield* requests;
      assert.strictEqual(request!.headers["x-content-length"], String(size));
      assert.deepStrictEqual(request!.body, bytes);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports a stream of unknown size with total equal to loaded", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      const { events, onUploadProgress } = yield* recorder;
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: Stream.make(bytes.subarray(0, 70_000), bytes.subarray(70_000)),
        onUploadProgress,
      });
      assert.deepStrictEqual(yield* events, [
        { loaded: 0, total: 0, percentage: 0 },
        { loaded: progressChunkSize, total: progressChunkSize, percentage: 0 },
        { loaded: 2 * progressChunkSize, total: 2 * progressChunkSize, percentage: 0 },
        { loaded: 3 * progressChunkSize, total: 3 * progressChunkSize, percentage: 0 },
        { loaded: size, total: size, percentage: 0 },
        { loaded: size, total: size, percentage: 100 },
      ]);
      const [request] = yield* requests;
      assert.strictEqual(request!.headers["x-content-length"], "0");
      assert.deepStrictEqual(request!.body, bytes);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("tracks progress of string and Blob bodies", () =>
    Effect.gen(function* () {
      yield* enqueue(ok, ok);
      const requester = yield* requesterWith();
      const first = yield* recorder;
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: "hello",
        onUploadProgress: first.onUploadProgress,
      });
      assert.deepStrictEqual(yield* first.events, [
        { loaded: 0, total: 5, percentage: 0 },
        { loaded: 5, total: 5, percentage: 100 },
      ]);
      const second = yield* recorder;
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: new Blob([bytes]),
        onUploadProgress: second.onUploadProgress,
      });
      assert.strictEqual((yield* second.events).length, 5);
      const [string, blob] = yield* requests;
      assert.strictEqual(string!.text, "hello");
      assert.deepStrictEqual(blob!.body, bytes);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("holds back throttled chunk events until the interval passes", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      const { events, onUploadProgress } = yield* recorder;
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: bytes,
        onUploadProgress,
        progressInterval: "100 millis",
      });
      assert.deepStrictEqual(yield* events, [
        { loaded: 0, total: size, percentage: 0 },
        { loaded: size, total: size, percentage: 100 },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports no 100 % when the upload fails", () =>
    Effect.gen(function* () {
      yield* enqueue(errorBody(403, "forbidden"));
      const requester = yield* requesterWith();
      const { events, onUploadProgress } = yield* recorder;
      yield* Effect.flip(
        requester.call({
          operation: "Test.put",
          method: "PUT",
          path: "/",
          auth: bearer(),
          body: "hello",
          onUploadProgress,
        }),
      );
      assert.deepStrictEqual(yield* events, [{ loaded: 0, total: 5, percentage: 0 }]);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("without request body streaming", () => {
  const bytes = new Uint8Array(3 * progressChunkSize + 10).map((_, index) => index % 251);

  it.effect("sends bodies whole and reports only 0 % and 100 %", () =>
    Effect.gen(function* () {
      yield* enqueue(ok, ok);
      const requester = yield* requesterWith({ streamRequestBodies: false });
      const first = yield* recorder;
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: bytes,
        onUploadProgress: first.onUploadProgress,
      });
      assert.deepStrictEqual(yield* first.events, [
        { loaded: 0, total: bytes.length, percentage: 0 },
        { loaded: bytes.length, total: bytes.length, percentage: 100 },
      ]);
      const second = yield* recorder;
      yield* requester.call({
        operation: "Test.put",
        method: "PUT",
        path: "/",
        auth: bearer(),
        body: Stream.make(bytes.subarray(0, 5), bytes.subarray(5)),
        onUploadProgress: second.onUploadProgress,
      });
      assert.deepStrictEqual(yield* second.events, [
        { loaded: 0, total: 0, percentage: 0 },
        { loaded: bytes.length, total: bytes.length, percentage: 100 },
      ]);
      const [whole, collected] = yield* requests;
      assert.deepStrictEqual(whole!.body, bytes);
      assert.deepStrictEqual(collected!.body, bytes);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with the body stream's error before sending anything", () =>
    Effect.gen(function* () {
      const requester = yield* requesterWith({ streamRequestBodies: false });
      const error = yield* Effect.flip(
        requester.call({
          operation: "Test.put",
          method: "PUT",
          path: "/",
          auth: bearer(),
          body: Stream.fail(new BodyFailed()),
        }),
      );
      assert.instanceOf(error, BodyFailed);
      assert.strictEqual((yield* requests).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("uploadProgressThrottle", () => {
  const event = (loaded: number): UploadProgress => ({ loaded, total: 100, percentage: loaded });
  const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

  it.effect("reports the latest event per interval, leading and trailing", () =>
    Effect.gen(function* () {
      const { events, onUploadProgress } = yield* recorder;
      const reporter = yield* uploadProgressThrottle(onUploadProgress, "100 millis");
      yield* reporter.report(event(1));
      yield* reporter.report(event(2));
      yield* settle;
      assert.deepStrictEqual(yield* events, []);
      yield* TestClock.adjust("100 millis");
      yield* settle;
      assert.deepStrictEqual(yield* events, [event(2)]);

      yield* reporter.report(event(3));
      yield* TestClock.adjust("50 millis");
      yield* settle;
      assert.deepStrictEqual(yield* events, [event(2)]);
      yield* TestClock.adjust("50 millis");
      yield* settle;
      assert.deepStrictEqual(yield* events, [event(2), event(3)]);

      yield* TestClock.adjust("1 second");
      yield* reporter.report(event(4));
      yield* settle;
      assert.deepStrictEqual(yield* events, [event(2), event(3), event(4)]);

      yield* reporter.stop;
      yield* reporter.report(event(5));
      yield* TestClock.adjust("1 second");
      yield* settle;
      assert.deepStrictEqual(yield* events, [event(2), event(3), event(4)]);
    }),
  );

  it.effect("reports every event immediately without an interval", () =>
    Effect.gen(function* () {
      const { events, onUploadProgress } = yield* recorder;
      const reporter = yield* uploadProgressThrottle(onUploadProgress, undefined);
      yield* reporter.report(event(1));
      yield* reporter.report(event(2));
      assert.deepStrictEqual(yield* events, [event(1), event(2)]);
    }),
  );
});

describe("supportsRequestStreams", () => {
  it("is always true on Node", () => {
    assert.isTrue(supportsRequestStreams("http://localhost:3000/api/blob"));
  });
});

describe("chunkBytes", () => {
  const collect = (chunks: ReadonlyArray<ReadonlyArray<number>>, size: number) =>
    Stream.fromIterable(chunks.map((chunk) => new Uint8Array(chunk))).pipe(
      chunkBytes(size),
      Stream.runCollect,
      Effect.map((out) => out.map((chunk) => Array.from(chunk))),
    );

  it.effect("accumulates small chunks and emits full-sized chunks", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* collect([[1, 2], [3, 4, 5, 6], [7]], 4), [
        [1, 2, 3, 4],
        [5, 6, 7],
      ]);
    }),
  );

  it.effect("splits large chunks and flushes the remainder", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* collect([[1, 2, 3, 4, 5]], 3), [
        [1, 2, 3],
        [4, 5],
      ]);
      assert.deepStrictEqual(yield* collect([[1, 2, 3]], 10), [[1, 2, 3]]);
      assert.deepStrictEqual(yield* collect([[], [1, 2, 3, 4]], 2), [
        [1, 2],
        [3, 4],
      ]);
    }),
  );
});

describe("serverBlobAuth", () => {
  const rwToken = "vercel_blob_rw_fallbackStore_30FakeRandomCharacters12345678";
  const config = (auth: BlobAuth, readWriteToken?: string): BlobConfig["Service"] => ({
    apiUrl: new URL("https://vercel.com/api/blob"),
    auth,
    readWriteToken: Option.map(Option.fromUndefinedOr(readWriteToken), Redacted.make),
    apiVersion: "13",
    retries: 0,
    sendContentLength: false,
    headers: {},
    blobBaseUrl: defaultBlobBaseUrl,
    webhookPublicKey: Option.none(),
    callbackBaseUrl: Option.none(),
  });
  const oidcStore = BlobAuth.Oidc({ storeId: StoreId.make("oidcStore") });
  const unavailable = VercelOidc.of({
    token: Effect.fail(new OidcTokenUnavailable({ message: "no token" })),
  });
  const describeAuth = (auth: BlobRequestAuth) =>
    BlobRequestAuth.$match(auth, {
      Bearer: ({ token, storeId }) => `${storeId}:${Redacted.value(token)}`,
      Presigned: ({ storeId }) => `presigned:${storeId}`,
    });

  it.effect("uses the read-write token", () =>
    Effect.gen(function* () {
      const auth = yield* serverBlobAuth(
        config(
          BlobAuth.ReadWrite({ token: Redacted.make(rwToken), storeId: StoreId.make("rwStore") }),
        ),
        unavailable,
      );
      assert.strictEqual(describeAuth(auth), `rwStore:${rwToken}`);
    }),
  );

  it.effect("evaluates the OIDC token on every call, so refreshed tokens are used", () =>
    Effect.gen(function* () {
      const tokens = yield* Ref.make(["oidc-jwt-initial", "oidc-jwt-refreshed"]);
      const oidc = VercelOidc.of({
        token: Ref.modify(tokens, ([first, ...rest]) => [Redacted.make(first!), rest]),
      });
      const auth = serverBlobAuth(config(oidcStore, rwToken), oidc);
      assert.strictEqual(describeAuth(yield* auth), "oidcStore:oidc-jwt-initial");
      assert.strictEqual(describeAuth(yield* auth), "oidcStore:oidc-jwt-refreshed");
    }),
  );

  it.effect("falls back to the read-write token and its store id without an OIDC token", () =>
    Effect.gen(function* () {
      const auth = yield* serverBlobAuth(config(oidcStore, rwToken), unavailable);
      assert.strictEqual(describeAuth(auth), `fallbackStore:${rwToken}`);
    }),
  );

  it.effect("fails with OidcTokenUnavailable without a fallback, before any request", () =>
    Effect.gen(function* () {
      const requester = yield* requesterWith();
      const error = yield* Effect.flip(
        requester.call({
          operation: "Test.call",
          method: "GET",
          path: "",
          auth: serverBlobAuth(config(oidcStore), unavailable),
        }),
      );
      assert.instanceOf(error, OidcTokenUnavailable);
      assert.strictEqual((yield* requests).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends the OIDC token with the store id", () =>
    Effect.gen(function* () {
      yield* enqueue(ok);
      const requester = yield* requesterWith();
      yield* requester.call({
        operation: "Test.call",
        method: "POST",
        path: "/method",
        auth: serverBlobAuth(
          config(oidcStore, rwToken),
          VercelOidc.of({ token: Effect.succeed(Redacted.make("oidc-jwt")) }),
        ),
      });
      const [request] = yield* requests;
      assert.strictEqual(request!.headers.authorization, "Bearer oidc-jwt");
      assert.strictEqual(request!.headers["x-vercel-blob-store-id"], "oidcStore");
      assert.match(request!.headers["x-api-blob-request-id"]!, /^oidcStore:\d+:[a-f0-9]+$/);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("blobRequester fetch", () => {
  it.effect("sends a bare GET with the bearer token and returns any status", () =>
    Effect.gen(function* () {
      yield* enqueue({ status: 404, body: "missing" });
      const server = yield* TestHttpServer;
      const requester = yield* requesterWith();
      const response = yield* requester.fetch({
        operation: "BlobStore.get",
        url: new URL(`${server.url}/store/a.txt?cache=0`),
        token: Redacted.make("rw"),
        headers: { "if-none-match": '"e"', "x-extra": "1" },
      });
      assert.strictEqual(response.status, 404);
      assert.strictEqual(yield* response.text, "missing");
      const [request] = yield* requests;
      assert.strictEqual(request!.method, "GET");
      assert.strictEqual(request!.url, "/store/a.txt?cache=0");
      assert.strictEqual(request!.headers.authorization, "Bearer rw");
      assert.strictEqual(request!.headers["if-none-match"], '"e"');
      assert.strictEqual(request!.headers["x-extra"], "1");
      assert.notProperty(request!.headers, "x-api-version");
      assert.notProperty(request!.headers, "traceparent");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports transport failures as ApiNetworkFailure", () =>
    Effect.gen(function* () {
      const requester = yield* requesterWith();
      const error = yield* Effect.flip(
        requester.fetch({
          operation: "BlobStore.get",
          url: new URL("http://127.0.0.1:1/a.txt"),
          token: Redacted.make("rw"),
        }),
      );
      assert.instanceOf(error.reason, ApiNetworkFailure);
      assert.strictEqual(error.operation, "BlobStore.get");
    }).pipe(Effect.provide(TestLayer)),
  );
});
