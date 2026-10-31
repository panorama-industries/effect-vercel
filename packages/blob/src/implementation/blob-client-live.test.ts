import type {
  TestHttpRequest,
  TestHttpResponse,
} from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import { VercelApiError } from "@panorama-industries/effect-vercel-core";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import { Config, ConfigProvider, Effect, Exit, Layer, Option, Ref, Result } from "effect";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import type { UploadProgress } from "../contracts/blob-domain.ts";
import type { BlobClientOptions } from "./blob-client-live.ts";

import { BlobClient } from "../contracts/blob-client.ts";
import {
  BlobPathname,
  ClientToken,
  MultipartUpload,
  PartNumber,
  PutBlobResult,
} from "../contracts/blob-domain.ts";
import {
  BlobUploadAuthorizationFailed,
  BlobUploadRejected,
  ClientTokenExpired,
  PathnameMismatch,
} from "../contracts/blob-errors.ts";
import { BlobClientLive, blobClientLayer } from "./blob-client-live.ts";

const fooTxt = BlobPathname.make("foo.txt");

const now = 1_700_000_000_000;

const json = (body: unknown, status = 200): TestHttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const errorBody = (status: number, code: string, message?: string) =>
  json({ error: { code, ...(message === undefined ? {} : { message }) } }, status);

const putResponse = json({
  url: "https://storeId.public.blob.vercel-storage.com/superfoo.txt",
  downloadUrl: "https://storeId.public.blob.vercel-storage.com/superfoo.txt?download=1",
  pathname: "foo.txt",
  contentType: "text/plain",
  contentDisposition: 'attachment; filename="foo.txt"',
  etag: '"abc123"',
});

const expectedPut = {
  contentDisposition: 'attachment; filename="foo.txt"',
  contentType: "text/plain",
  // `URL` lower-cases the host.
  downloadUrl: "https://storeid.public.blob.vercel-storage.com/superfoo.txt?download=1",
  etag: '"abc123"',
  pathname: "foo.txt",
  url: "https://storeid.public.blob.vercel-storage.com/superfoo.txt",
};

const plain = (result: PutBlobResult) => ({
  contentDisposition: result.contentDisposition,
  contentType: result.contentType,
  downloadUrl: result.downloadUrl.href,
  etag: result.etag,
  pathname: result.pathname,
  url: result.url.href,
});

const clientTokenRoute = json({
  type: "blob.generate-client-token",
  clientToken: "vercel_blob_client_fake_123",
});

/** Answers the upload route (`/api/…upload`) and the Blob API (`/api/blob…`) by path. */
const route =
  (upload: TestHttpResponse, api: TestHttpResponse = putResponse) =>
  (request: TestHttpRequest): TestHttpResponse =>
    request.url.startsWith("/api/blob")
      ? api
      : request.url.includes("upload")
        ? upload
        : json({}, 404);

const TestLayer = Layer.mergeAll(
  TestHttpServerLive(),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromUnknown({})),
);

const server = Effect.service(TestHttpServer);

const requests = Effect.flatMap(server, (server) => server.requests);

const serve = (upload: TestHttpResponse, api?: TestHttpResponse) =>
  Effect.flatMap(server, (server) => server.setHandler(route(upload, api)));

/** A `BlobClient` whose Blob API is the test server's `/api/blob`. */
const clientWith = (options: BlobClientOptions = {}) =>
  Effect.gen(function* () {
    const { url } = yield* server;
    return yield* Effect.service(BlobClient).pipe(
      Effect.provide(blobClientLayer({ apiUrl: `${url}/api/blob`, ...options })),
    );
  });

/** Runs `effect` with `globalThis.location` set to `{ href }`, as in a page or web worker. */
const withLocation = <A, E, R>(href: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
      Object.defineProperty(globalThis, "location", {
        value: { href },
        configurable: true,
        writable: true,
      });
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          Reflect.deleteProperty(globalThis, "location");
        } else {
          Object.defineProperty(globalThis, "location", previous);
        }
      }),
  );

/** The protocol headers of a request: `authorization` and every `x-*` header. */
const protocolHeaders = (request: TestHttpRequest | undefined): Record<string, string> => {
  assert.isDefined(request);
  return Object.fromEntries(
    Object.entries(request!.headers).filter(
      ([name]) => name === "authorization" || name.startsWith("x-"),
    ),
  );
};

/** Protocol headers without the request id, after checking the id's shape. */
const apiHeaders = (request: TestHttpRequest | undefined, storeId: string) => {
  const { "x-api-blob-request-id": requestId, ...rest } = protocolHeaders(request);
  assert.match(requestId ?? "", new RegExp(`^${storeId}:${now}:[0-9a-f]+$`));
  return rest;
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
  assert.isDefined(error);
  return (error as { readonly error: E }).error;
};

const delegationToken = (payload: unknown) =>
  `${Base64Url.encode(new TextEncoder().encode(JSON.stringify(payload)))}.signature-part`;

describe("BlobClientLive upload", () => {
  it.effect("uploads a file from the client", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* serve(clientTokenRoute);
      const { url } = yield* server;
      const client = yield* clientWith();
      const result = yield* withLocation(
        `${url}/`,
        client.upload(fooTxt, "Test file data", {
          access: "public",
          handleUploadUrl: "/api/upload",
        }),
      );
      assert.deepStrictEqual(plain(result), expectedPut);

      const all = yield* requests;
      assert.strictEqual(all.length, 2);
      const [token, put] = all;
      assert.strictEqual(token!.method, "POST");
      assert.strictEqual(token!.url, "/api/upload");
      assert.strictEqual(
        token!.text,
        '{"type":"blob.generate-client-token","payload":{"pathname":"foo.txt","clientPayload":null,"multipart":false}}',
      );
      assert.strictEqual(token!.headers["content-type"], "application/json");
      assert.deepStrictEqual(protocolHeaders(token), {});

      assert.strictEqual(put!.method, "PUT");
      assert.strictEqual(put!.url, "/api/blob/?pathname=foo.txt");
      assert.strictEqual(put!.text, "Test file data");
      assert.deepStrictEqual(apiHeaders(put, "fake"), {
        authorization: "Bearer vercel_blob_client_fake_123",
        "x-api-blob-request-attempt": "0",
        "x-vercel-blob-store-id": "fake",
        "x-api-version": "13",
        "x-vercel-blob-access": "public",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("uploads in parts with multipart: true", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const { url } = yield* server;
      yield* Effect.flatMap(server, (server) =>
        server.setHandler((request) => {
          if (!request.url.startsWith("/api/blob")) return clientTokenRoute;
          switch (request.headers["x-mpu-action"]) {
            case "create":
              return json({ uploadId: "upload-1", key: "key-1" });
            case "upload":
              return json({ etag: "etag1" });
            default:
              return putResponse;
          }
        }),
      );
      const client = yield* clientWith();
      const result = yield* client.upload(fooTxt, "Test file data", {
        access: "public",
        contentType: "text/plain",
        handleUploadUrl: `${url}/api/upload`,
        multipart: true,
      });
      assert.deepStrictEqual(plain(result), expectedPut);

      const [token, ...mpu] = yield* requests;
      assert.include(token!.text, '"multipart":true');
      assert.deepStrictEqual(
        mpu.map((request) => [request.url, request.headers["x-mpu-action"]]),
        [
          ["/api/blob/mpu?pathname=foo.txt", "create"],
          ["/api/blob/mpu?pathname=foo.txt", "upload"],
          ["/api/blob/mpu?pathname=foo.txt", "complete"],
        ],
      );
      for (const request of mpu) {
        assert.strictEqual(request.headers["authorization"], "Bearer vercel_blob_client_fake_123");
        assert.strictEqual(request.headers["x-vercel-blob-access"], "public");
        assert.strictEqual(request.headers["x-content-type"], "text/plain");
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("uploads a file with private access", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* serve(clientTokenRoute);
      const { url } = yield* server;
      const client = yield* clientWith();
      const result = yield* withLocation(
        `${url}/`,
        client.upload(fooTxt, "Test file data", {
          access: "private",
          handleUploadUrl: "/api/upload",
        }),
      );
      assert.deepStrictEqual(plain(result), expectedPut);

      const [, put] = yield* requests;
      assert.strictEqual(put!.url, "/api/blob/?pathname=foo.txt");
      assert.strictEqual(put!.text, "Test file data");
      assert.deepStrictEqual(apiHeaders(put, "fake"), {
        authorization: "Bearer vercel_blob_client_fake_123",
        "x-api-blob-request-attempt": "0",
        "x-vercel-blob-store-id": "fake",
        "x-api-version": "13",
        "x-vercel-blob-access": "private",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends the client payload, route headers and content type", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* serve(clientTokenRoute);
      const { url } = yield* server;
      const client = yield* clientWith();
      yield* client.upload(BlobPathname.make("folder/a b.txt"), "data", {
        access: "public",
        handleUploadUrl: `${url}/api/upload`,
        clientPayload: '{"postId":1}',
        contentType: "text/csv",
        headers: { "x-csrf-token": "secret", authorization: "Bearer session" },
      });
      const [token, put] = yield* requests;
      assert.strictEqual(
        token!.text,
        JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname: "folder/a b.txt", clientPayload: '{"postId":1}', multipart: false },
        }),
      );
      assert.deepStrictEqual(protocolHeaders(token), {
        "x-csrf-token": "secret",
        authorization: "Bearer session",
      });
      assert.strictEqual(put!.url, "/api/blob/?pathname=folder%2Fa+b.txt");
      assert.deepStrictEqual(apiHeaders(put, "fake"), {
        authorization: "Bearer vercel_blob_client_fake_123",
        "x-api-blob-request-attempt": "0",
        "x-vercel-blob-store-id": "fake",
        "x-api-version": "13",
        "x-vercel-blob-access": "public",
        "x-content-type": "text/csv",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resolves a relative upload route against the page's location", () =>
    Effect.gen(function* () {
      yield* serve(clientTokenRoute);
      const { url } = yield* server;
      const client = yield* clientWith();
      yield* withLocation(
        `${url}/dashboard/files?tab=1#top`,
        client.upload(fooTxt, "data", { access: "public", handleUploadUrl: "api/upload" }),
      );
      yield* withLocation(
        `${url}/dashboard/files`,
        client.upload(fooTxt, "data", { access: "public", handleUploadUrl: "/api/upload?v=2" }),
      );
      const [first, , second] = yield* requests;
      assert.strictEqual(first!.url, "/dashboard/api/upload");
      assert.strictEqual(second!.url, "/api/upload?v=2");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("dies on a relative upload route without globalThis.location", () =>
    Effect.gen(function* () {
      assert.isUndefined(Reflect.get(globalThis, "location"));
      yield* serve(clientTokenRoute);
      const client = yield* clientWith();
      const exit = yield* Effect.exit(
        client.upload(fooTxt, "data", { access: "public", handleUploadUrl: "/api/upload" }),
      );
      assert.isTrue(Exit.hasDies(exit));
      const defect = Exit.findDefect(exit);
      assert.isTrue(Result.isSuccess(defect));
      assert.include(String(Result.getOrThrow(defect)), "globalThis.location");
      assert.strictEqual((yield* requests).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with BlobUploadAuthorizationFailed when the route answers non-2xx", () =>
    Effect.gen(function* () {
      yield* serve(json({ error: "Not authenticated" }, 401));
      const { url } = yield* server;
      const client = yield* clientWith();
      const error = failureOf(
        yield* Effect.exit(
          client.upload(fooTxt, "data", {
            access: "public",
            handleUploadUrl: `${url}/api/upload`,
          }),
        ),
      );
      assert.instanceOf(error, BlobUploadAuthorizationFailed);
      const failed = error as BlobUploadAuthorizationFailed;
      assert.deepStrictEqual(failed.status, Option.some(401));
      assert.strictEqual(failed.message, "Failed to  retrieve the client token");
      assert.strictEqual((yield* requests).length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with BlobUploadAuthorizationFailed when the route body has no token", () =>
    Effect.gen(function* () {
      const { url } = yield* server;
      const client = yield* clientWith();
      const bodies: ReadonlyArray<TestHttpResponse> = [
        { status: 200, headers: { "content-type": "text/html" }, body: "<html></html>" },
        json({ type: "blob.generate-client-token" }),
        json({ clientToken: "vercel_blob_rw_store_secret" }),
      ];
      for (const body of bodies) {
        yield* serve(body);
        const error = failureOf(
          yield* Effect.exit(
            client.upload(fooTxt, "data", {
              access: "public",
              handleUploadUrl: `${url}/api/upload`,
            }),
          ),
        ) as BlobUploadAuthorizationFailed;
        assert.instanceOf(error, BlobUploadAuthorizationFailed);
        assert.deepStrictEqual(error.status, Option.some(200));
        assert.strictEqual(error.message, "Failed to retrieve the client token");
      }
      assert.strictEqual((yield* requests).length, bodies.length);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with BlobUploadAuthorizationFailed when the route is unreachable", () =>
    Effect.gen(function* () {
      const client = yield* clientWith();
      const error = failureOf(
        yield* Effect.exit(
          client.upload(fooTxt, "data", {
            access: "public",
            handleUploadUrl: "http://127.0.0.1:1/api/upload",
          }),
        ),
      ) as BlobUploadAuthorizationFailed;
      assert.instanceOf(error, BlobUploadAuthorizationFailed);
      assert.isTrue(Option.isNone(error.status));
      assert.strictEqual(error.message, "Failed to  retrieve the client token");
      assert.isDefined(error.cause);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports progress: 0 % first, throttled chunks, 100 % after the response", () =>
    Effect.gen(function* () {
      yield* serve(clientTokenRoute);
      const { url } = yield* server;
      const client = yield* clientWith();
      const events = yield* Ref.make<ReadonlyArray<UploadProgress>>([]);
      const body = new Uint8Array(200 * 1024).fill(7);
      yield* client.upload(fooTxt, body, {
        access: "public",
        handleUploadUrl: `${url}/api/upload`,
        onUploadProgress: (progress) => Ref.update(events, (all) => [...all, progress]),
      });
      // The test clock does not move, so every chunk event falls inside the 100 ms throttle.
      assert.deepStrictEqual(yield* Ref.get(events), [
        { loaded: 0, total: body.length, percentage: 0 },
        { loaded: body.length, total: body.length, percentage: 100 },
      ]);
      const [, put] = yield* requests;
      assert.strictEqual(put!.body.length, body.length);
      assert.strictEqual(put!.headers["x-content-length"], String(body.length));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("maps upload rejections to the client's domain errors", () =>
    Effect.gen(function* () {
      const { url } = yield* server;
      const client = yield* clientWith({ retries: 0 });
      const upload = client.upload(fooTxt, "data", {
        access: "public",
        handleUploadUrl: `${url}/api/upload`,
      });

      yield* serve(
        clientTokenRoute,
        errorBody(
          400,
          "bad_request",
          'The "pathname" foo.txt does not match the token payload "bar.txt"',
        ),
      );
      const mismatch = failureOf(yield* Effect.exit(upload)) as BlobUploadRejected;
      assert.instanceOf(mismatch, BlobUploadRejected);
      assert.instanceOf(mismatch.reason, PathnameMismatch);

      yield* serve(clientTokenRoute, errorBody(403, "forbidden", "Token expired"));
      const expired = failureOf(yield* Effect.exit(upload)) as BlobUploadRejected;
      assert.instanceOf(expired, BlobUploadRejected);
      assert.instanceOf(expired.reason, ClientTokenExpired);

      // `not_found` is not among the client's domain errors.
      yield* serve(clientTokenRoute, errorBody(404, "not_found"));
      const notFound = failureOf(yield* Effect.exit(upload));
      assert.instanceOf(notFound, VercelApiError);
      assert.deepStrictEqual((notFound as VercelApiError).errorCode, Option.some("not_found"));
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("BlobClientLive uploadPresigned", () => {
  const payload = {
    delegationToken: delegationToken({ storeId: "store_PresignedStore", ownerId: "team_1" }),
    signature: "c2lnbmF0dXJl",
    params: {
      pathname: "foo.txt",
      "vercel-blob-operation": "put",
      "vercel-blob-valid-until": "1700000060000",
    },
  };

  const presignedRoute = json({
    type: "blob.generate-presigned-url",
    presignedUrlPayload: payload,
  });

  it.effect("uploads with the payload's query parameters and no authorization", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* serve(presignedRoute);
      const { url } = yield* server;
      const client = yield* clientWith();
      const result = yield* withLocation(
        `${url}/`,
        client.uploadPresigned(fooTxt, "Test file data", {
          access: "public",
          handleUploadUrl: "/api/upload-presigned",
          clientPayload: "cp",
        }),
      );
      assert.deepStrictEqual(plain(result), expectedPut);

      const [route, put] = yield* requests;
      assert.strictEqual(route!.url, "/api/upload-presigned");
      assert.strictEqual(
        route!.text,
        '{"type":"blob.generate-presigned-url","payload":{"pathname":"foo.txt","clientPayload":"cp","multipart":false}}',
      );
      assert.strictEqual(route!.headers["content-type"], "application/json");

      const expectedUrl = new URL(`${url}/api/blob/?pathname=foo.txt`);
      for (const [key, value] of Object.entries(payload.params)) {
        expectedUrl.searchParams.set(key, value);
      }
      expectedUrl.searchParams.set("vercel-blob-delegation", payload.delegationToken);
      expectedUrl.searchParams.set("vercel-blob-signature", payload.signature);
      assert.strictEqual(put!.method, "PUT");
      assert.strictEqual(put!.url, `${expectedUrl.pathname}${expectedUrl.search}`);
      assert.strictEqual(put!.text, "Test file data");
      assert.deepStrictEqual(apiHeaders(put, "PresignedStore"), {
        "x-api-blob-request-attempt": "0",
        "x-vercel-blob-store-id": "PresignedStore",
        "x-api-version": "13",
        "x-vercel-blob-access": "public",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with the SDK's messages when the route cannot presign", () =>
    Effect.gen(function* () {
      const { url } = yield* server;
      const client = yield* clientWith();
      const upload = client.uploadPresigned(fooTxt, "data", {
        access: "public",
        handleUploadUrl: `${url}/api/upload-presigned`,
      });
      const cases: ReadonlyArray<readonly [TestHttpResponse, Option.Option<number>, string]> = [
        [json({}, 500), Option.some(500), "Failed to retrieve the presigned URL"],
        [
          { status: 200, headers: { "content-type": "text/plain" }, body: "nope" },
          Option.some(200),
          "Failed to retrieve the presigned URL",
        ],
        [
          json({ type: "blob.generate-presigned-url" }),
          Option.some(200),
          "Missing presignedUrlPayload",
        ],
        [
          json({ presignedUrlPayload: { ...payload, delegationToken: "no-dot" } }),
          Option.some(200),
          "Invalid delegation token format.",
        ],
        [
          json({ presignedUrlPayload: { ...payload, delegationToken: delegationToken({}) } }),
          Option.some(200),
          "Invalid delegation token payload.",
        ],
      ];
      for (const [response, status, message] of cases) {
        yield* serve(response);
        const error = failureOf(yield* Effect.exit(upload)) as BlobUploadAuthorizationFailed;
        assert.instanceOf(error, BlobUploadAuthorizationFailed);
        assert.deepStrictEqual(error.status, status);
        assert.strictEqual(error.message, message);
      }
      // No upload was attempted.
      assert.isTrue((yield* requests).every((request) => !request.url.startsWith("/api/blob")));
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("BlobClientLive put", () => {
  it.effect("uploads a file with a client token (index.browser)", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* serve(json({}, 404));
      const client = yield* clientWith();
      const result = yield* client.put(fooTxt, "Test Body", {
        access: "public",
        token: ClientToken.make("vercel_blob_client_123_token"),
        contentType: "text/plain",
      });
      assert.deepStrictEqual(plain(result), expectedPut);
      const [put] = yield* requests;
      assert.strictEqual(put!.method, "PUT");
      assert.strictEqual(put!.url, "/api/blob/?pathname=foo.txt");
      assert.strictEqual(put!.text, "Test Body");
      assert.deepStrictEqual(apiHeaders(put, "123"), {
        authorization: "Bearer vercel_blob_client_123_token",
        "x-api-blob-request-attempt": "0",
        "x-vercel-blob-store-id": "123",
        "x-api-version": "13",
        "x-vercel-blob-access": "public",
        "x-content-type": "text/plain",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it("rejects options and bodies the SDK rejects at runtime, at compile time", () => {
    const token = ClientToken.make("vercel_blob_client_fake_123");
    const upload = MultipartUpload.make({
      pathname: fooTxt,
      key: "foo.txt",
      uploadId: "1",
      access: "public",
    });
    const checks = (client: BlobClient["Service"]) => [
      // @ts-expect-error: a plain object is not a body
      client.put(fooTxt, { file: "value" }, { access: "public", token }),
      // @ts-expect-error: a plain object is not a body
      client.put(fooTxt, { file: "value" }, { access: "public", token, multipart: true }),
      client.upload(
        fooTxt,
        // @ts-expect-error: a plain object is not a body
        { file: "value" },
        { access: "public", handleUploadUrl: "/api/upload" },
      ),
      // @ts-expect-error: a plain object is not a body
      client.uploadPart(upload, PartNumber.make(1), { file: "value" }, { token }),
      client.upload(fooTxt, "Test file data", {
        access: "public",
        handleUploadUrl: "/api/upload",
        // @ts-expect-error: the server decides `ifMatch` when it issues the token
        ifMatch: "some-etag",
      }),
      client.put(fooTxt, "data", {
        access: "public",
        token,
        // @ts-expect-error: the server decides random suffixes when it issues the token
        addRandomSuffix: true,
      }),
      // @ts-expect-error: put must be called with a client token
      client.put(fooTxt, "data", { access: "public", token: "vercel_blob_rw_store_secret" }),
    ];
    assert.isFunction(checks);
  });
});

describe("BlobClientLive configuration", () => {
  const configured = (vars: Record<string, string>, options?: BlobClientOptions) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* serve(json({}, 404));
      const client = yield* Effect.service(BlobClient).pipe(
        Effect.provide(options === undefined ? BlobClientLive : blobClientLayer(options)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars))),
      );
      yield* client.put(fooTxt, "data", {
        access: "public",
        token: ClientToken.make("vercel_blob_client_fake_123"),
      });
      const all = yield* requests;
      return all[all.length - 1];
    });

  it.effect("reads the API URL, API version and proxy header from the environment", () =>
    Effect.gen(function* () {
      const { url } = yield* server;
      const put = yield* configured({
        VERCEL_BLOB_API_URL: `${url}/api/blob`,
        VERCEL_BLOB_API_VERSION_OVERRIDE: "14",
        VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API: "1",
      });
      assert.strictEqual(put!.url, "/api/blob/?pathname=foo.txt");
      assert.strictEqual(put!.headers["x-api-version"], "14");
      assert.strictEqual(put!.headers["x-proxy-through-alternative-api"], "1");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("falls back to the NEXT_PUBLIC_ variables and ignores blank ones", () =>
    Effect.gen(function* () {
      const { url } = yield* server;
      const put = yield* configured({
        VERCEL_BLOB_API_URL: "  ",
        NEXT_PUBLIC_VERCEL_BLOB_API_URL: `${url}/api/blob`,
        NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE: "15",
        NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API: "alt",
        VERCEL_BLOB_RETRIES: "",
      });
      assert.strictEqual(put!.url, "/api/blob/?pathname=foo.txt");
      assert.strictEqual(put!.headers["x-api-version"], "15");
      assert.strictEqual(put!.headers["x-proxy-through-alternative-api"], "alt");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends x-content-length with VERCEL_BLOB_USE_X_CONTENT_LENGTH=1", () =>
    Effect.gen(function* () {
      const { url } = yield* server;
      const put = yield* configured(
        { VERCEL_BLOB_USE_X_CONTENT_LENGTH: "1" },
        { apiUrl: `${url}/api/blob` },
      );
      assert.strictEqual(put!.headers["x-content-length"], "4");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("merges the headers option over the environment's", () =>
    Effect.gen(function* () {
      const { url } = yield* server;
      const put = yield* configured(
        { VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API: "env" },
        { apiUrl: `${url}/api/blob`, headers: { "x-proxy-through-alternative-api": "option" } },
      );
      assert.strictEqual(put!.headers["x-proxy-through-alternative-api"], "option");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with a ConfigError for an invalid API URL or VERCEL_BLOB_RETRIES", () =>
    Effect.gen(function* () {
      const build = (vars: Record<string, string>, options?: BlobClientOptions) =>
        Effect.flip(
          Effect.service(BlobClient).pipe(
            Effect.provide(options === undefined ? BlobClientLive : blobClientLayer(options)),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars))),
          ),
        );
      const retries = yield* build({ VERCEL_BLOB_RETRIES: "-1" });
      assert.instanceOf(retries, Config.ConfigError);
      assert.include(String(retries), 'Invalid VERCEL_BLOB_RETRIES "-1"');
      const apiUrl = yield* build({ VERCEL_BLOB_API_URL: "not a url" });
      assert.instanceOf(apiUrl, Config.ConfigError);
      assert.include(String(apiUrl), 'Invalid Blob API URL "not a url"');
      const option = yield* build({}, { retries: 1.5 });
      assert.include(String(option), "Invalid retries 1.5");
    }).pipe(Effect.provide(TestLayer)),
  );
});
