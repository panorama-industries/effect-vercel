import type {
  TestHttpRequest,
  TestHttpResponse,
} from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import { ApiBadRequest, VercelApiError } from "@panorama-industries/effect-vercel-core";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import type { UploadProgress } from "../contracts/blob-domain.ts";
import type { MultipartPutOptions, MultipartWriteOptions } from "./multipart.ts";

import { BlobPathname, ClientToken, ETag } from "../contracts/blob-domain.ts";
import { BlobUploadRejected, FileTooLarge } from "../contracts/blob-errors.ts";
import { BlobRequestAuth, blobRequester, progressChunkSize } from "./blob-request.ts";
import {
  clientMultipartWriteOptions,
  multipartPartSize,
  multipartPut,
  serverMultipartWriteOptions,
} from "./multipart.ts";
import { storeIdFromClientToken } from "./store-id.ts";

const readWriteToken = "vercel_blob_rw_12345fakeStoreId_30FakeRandomCharacters12345678";
const clientToken = ClientToken.make("vercel_blob_client_fake_token_for_test");
const BLOB_STORE_BASE_URL = "https://storeId.public.blob.vercel-storage.com";
const MiB8 = multipartPartSize;

class BodyFailed extends Schema.TaggedError<BodyFailed>()("BodyFailed", {}) {}

const TestLayer = Layer.mergeAll(TestHttpServerLive(), FetchHttpClient.layer);

/** Counts HTTP requests interrupted while in flight. */
const makeTarget = (options: {
  readonly client?: boolean | undefined;
  readonly streamRequestBodies?: boolean | undefined;
}) =>
  Effect.gen(function* () {
    const server = yield* TestHttpServer;
    const interrupted = yield* Ref.make(0);
    const httpClient = HttpClient.transform(yield* HttpClient.HttpClient, (effect) =>
      Effect.onInterrupt(effect, () => Ref.update(interrupted, (n) => n + 1)),
    );
    const writeOptions: MultipartWriteOptions = options.client
      ? clientMultipartWriteOptions
      : serverMultipartWriteOptions;
    const target = {
      requester: blobRequester({
        httpClient,
        apiUrl: new URL(`${server.url}/api/blob`),
        apiVersion: "13",
        retries: 0,
        sendContentLength: false,
        headers: {},
        streamRequestBodies: options.streamRequestBodies,
      }),
      auth: Effect.succeed(
        options.client
          ? BlobRequestAuth.Bearer({
              token: Redacted.make<string>(clientToken),
              storeId: Option.getOrThrow(storeIdFromClientToken(clientToken)),
            })
          : BlobRequestAuth.Bearer({
              token: Redacted.make(readWriteToken),
              storeId: "12345fakeStoreId",
            }),
      ),
      service: options.client ? "BlobClient" : "BlobStore",
      domainErrors: [
        "BlobStoreUnavailable",
        "BlobOidcEnvironmentNotAllowed",
        "BlobPreconditionFailed",
        "BlobUploadRejected",
      ] as const,
      writeOptions,
    };
    return { target, interrupted: Ref.get(interrupted) };
  });

const serverTarget = makeTarget({});

const json = (status: number, body: unknown): TestHttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const mockedPutResponse = {
  url: `${BLOB_STORE_BASE_URL}/foo.txt`,
  downloadUrl: `${BLOB_STORE_BASE_URL}/foo.txt?download=1`,
  pathname: "foo.txt",
  contentType: "text/plain",
  contentDisposition: 'attachment; filename="foo.txt"',
  etag: '"empty"',
};

const partNumberOf = (request: TestHttpRequest): number =>
  Number(request.headers["x-mpu-part-number"]);

/**
 * Answers `create` and `complete`, and each part with `etag-<n>` unless `onPart` replies first.
 */
const useMpuHandler = (
  onPart?: (request: TestHttpRequest) => Effect.Effect<TestHttpResponse | undefined>,
) =>
  Effect.flatMap(Effect.service(TestHttpServer), (server) =>
    server.setHandler((request) =>
      Effect.gen(function* () {
        switch (request.headers["x-mpu-action"]) {
          case "create":
            return json(200, { uploadId: "upload-123", key: "foo.txt" });
          case "upload": {
            const reply = onPart === undefined ? undefined : yield* onPart(request);
            return reply ?? json(200, { etag: `etag-${partNumberOf(request)}` });
          }
          case "complete":
            return json(200, mockedPutResponse);
          default:
            return json(400, { error: { code: "bad_request" } });
        }
      }),
    ),
  );

const requests = Effect.flatMap(Effect.service(TestHttpServer), (server) => server.requests);

const requestsWith = (action: string) =>
  Effect.map(requests, (all) =>
    all.filter((request) => request.headers["x-mpu-action"] === action),
  );

/** Waits in real time until `condition` holds; the test clock does not move meanwhile. */
const eventually = <R>(condition: Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    while (!(yield* condition)) {
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
  });

const liveSleep = (millis: number) => TestClock.withLive(Effect.sleep(`${millis} millis`));

const recorder = Effect.gen(function* () {
  const events = yield* Ref.make<ReadonlyArray<UploadProgress>>([]);
  return {
    events: Ref.get(events),
    onUploadProgress: (progress: UploadProgress) => Ref.update(events, (all) => [...all, progress]),
  };
});

const pct = (loaded: number, total: number) => Number(((loaded / total) * 100).toFixed(2));

const bytesOf = (size: number) => new Uint8Array(size).map((_, index) => (index * 7) % 251);

const fooTxt = BlobPathname.make("foo.txt");
const publicAccess: MultipartPutOptions = { access: "public" };

const completedParts = Effect.map(requestsWith("complete"), (all) =>
  all.map((request) => JSON.parse(request.text) as unknown),
);

describe("multipartPut size limit", () => {
  it.effect.each([
    ["Blob", new Blob([new Uint8Array(1024)])],
    ["Uint8Array", new Uint8Array(1024)],
    ["string", "x".repeat(1024)],
  ] as const)("throws when a %s body exceeds maximumSizeInBytes", ([, body]) =>
    Effect.gen(function* () {
      const { target } = yield* serverTarget;
      const { events, onUploadProgress } = yield* recorder;
      const error = yield* Effect.flip(
        multipartPut(target, fooTxt, body, {
          access: "public",
          maximumSizeInBytes: 512,
          onUploadProgress,
        }),
      );
      assert.deepStrictEqual(
        error,
        new BlobUploadRejected({
          reason: new FileTooLarge({
            message: "Body size of 1024 bytes exceeds the maximum allowed size of 512 bytes",
          }),
        }),
      );
      assert.strictEqual((yield* requests).length, 0);
      assert.deepStrictEqual(yield* events, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("accepts a body of exactly maximumSizeInBytes", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      yield* multipartPut(target, fooTxt, new Uint8Array(512), {
        access: "public",
        maximumSizeInBytes: 512,
      });
      assert.strictEqual((yield* requests).length, 3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "does not throw client-side size error for stream body with maximumSizeInBytes in a multipart put",
    () =>
      Effect.gen(function* () {
        yield* useMpuHandler();
        const { target } = yield* serverTarget;
        const blob = yield* multipartPut(
          target,
          fooTxt,
          Stream.make(new TextEncoder().encode("hello")),
          { access: "public", maximumSizeInBytes: 1 },
        );
        assert.strictEqual(blob.pathname, "foo.txt");
        const [part] = yield* requestsWith("upload");
        assert.strictEqual(part!.text, "hello");
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe("multipartPut empty bodies", () => {
  it.effect.each([
    ["an empty stream", Stream.empty],
    ["an empty string", ""],
    ["empty bytes", new Uint8Array(0)],
    ["an empty Blob", new Blob([])],
  ] as const)("resolves (does not hang) with %s, completing with no parts", ([, body]) =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      const blob = yield* multipartPut(target, fooTxt, body, publicAccess);
      assert.strictEqual(blob.pathname, "foo.txt");
      assert.strictEqual(blob.etag, '"empty"');
      const actions = (yield* requests).map((request) => request.headers["x-mpu-action"]);
      assert.deepStrictEqual(actions, ["create", "complete"]);
      assert.deepStrictEqual(yield* completedParts, [[]]);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("multipartPut parts", () => {
  const assertParts = (expected: Uint8Array, sizes: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const parts = (yield* requestsWith("upload")).toSorted(
        (a, b) => partNumberOf(a) - partNumberOf(b),
      );
      assert.deepStrictEqual(
        parts.map((part) => part.body.length),
        sizes,
      );
      assert.deepStrictEqual(
        parts.map(partNumberOf),
        sizes.map((_, index) => index + 1),
      );
      let offset = 0;
      for (const part of parts) {
        assert.isTrue(
          Buffer.from(part.body).equals(expected.subarray(offset, offset + part.body.length)),
        );
        offset += part.body.length;
      }
      assert.deepStrictEqual(yield* completedParts, [
        sizes.map((_, index) => ({ etag: `etag-${index + 1}`, partNumber: index + 1 })),
      ]);
    });

  it.effect("splits at exact 8 MiB boundaries", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      const bytes = bytesOf(2 * MiB8);
      yield* multipartPut(target, fooTxt, bytes, publicAccess);
      yield* assertParts(bytes, [MiB8, MiB8]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends a smaller last part, from a Blob", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      const bytes = bytesOf(2 * MiB8 + 5);
      yield* multipartPut(target, fooTxt, new Blob([bytes]), publicAccess);
      yield* assertParts(bytes, [MiB8, MiB8, 5]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("regroups a stream of uneven chunks into exact parts", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      const bytes = bytesOf(2 * MiB8 + 5);
      const cuts = [0, 1, 3 * 1024 * 1024 + 7, MiB8, MiB8 + 1, 2 * MiB8 + 4, bytes.length];
      const chunks = cuts.slice(1).map((end, index) => bytes.slice(cuts[index], end));
      yield* multipartPut(target, fooTxt, Stream.fromIterable(chunks), publicAccess);
      yield* assertParts(bytes, [MiB8, MiB8, 5]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends a small string body as one part", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      const blob = yield* multipartPut(target, fooTxt, "Big file", publicAccess);
      assert.strictEqual(blob.url.href, new URL(`${BLOB_STORE_BASE_URL}/foo.txt`).href);
      const [part] = yield* requestsWith("upload");
      assert.strictEqual(part!.text, "Big file");
      assert.deepStrictEqual(yield* completedParts, [[{ etag: "etag-1", partNumber: 1 }]]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("completes with the parts in part-number order when they finish out of order", () =>
    Effect.gen(function* () {
      const firstPart = yield* Deferred.make<void>();
      yield* useMpuHandler((request) =>
        partNumberOf(request) === 1
          ? Effect.as(Deferred.await(firstPart), undefined)
          : Effect.succeed(undefined),
      );
      const { target } = yield* serverTarget;
      const fiber = yield* Effect.forkChild(
        multipartPut(target, fooTxt, bytesOf(MiB8 + 1), publicAccess),
      );
      yield* eventually(Effect.map(requestsWith("upload"), (parts) => parts.length === 2));
      yield* liveSleep(50);
      yield* Deferred.succeed(firstPart, undefined);
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(yield* completedParts, [
        [
          { etag: "etag-1", partNumber: 1 },
          { etag: "etag-2", partNumber: 2 },
        ],
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("multipartPut headers", () => {
  it.effect("sends the put options on create, every part and complete, as the SDK", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      yield* multipartPut(target, BlobPathname.make("a b/ü.txt"), "data", {
        access: "private",
        addRandomSuffix: true,
        contentType: "text/plain",
        cacheControlMaxAge: "1 hour",
        ifMatch: ETag.make('"etag"'),
      });
      const sent = yield* requests;
      assert.deepStrictEqual(
        sent.map((request) => request.headers["x-mpu-action"]),
        ["create", "upload", "complete"],
      );
      for (const request of sent) {
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(
          request.url,
          `/api/blob/mpu?${new URLSearchParams({ pathname: "a b/ü.txt" })}`,
        );
        assert.strictEqual(request.headers.authorization, `Bearer ${readWriteToken}`);
        assert.strictEqual(request.headers["x-vercel-blob-store-id"], "12345fakeStoreId");
        assert.strictEqual(request.headers["x-api-blob-request-attempt"], "0");
        assert.strictEqual(request.headers["x-api-version"], "13");
        assert.strictEqual(request.headers["x-vercel-blob-access"], "private");
        assert.strictEqual(request.headers["x-add-random-suffix"], "1");
        assert.strictEqual(request.headers["x-content-type"], "text/plain");
        assert.strictEqual(request.headers["x-cache-control-max-age"], "3600");
        assert.strictEqual(request.headers["x-if-match"], '"etag"');
        assert.strictEqual(request.headers["x-allow-overwrite"], "1");
        assert.isUndefined(request.headers["x-content-length"]);
      }
      const [, part, complete] = sent;
      assert.strictEqual(part!.headers["x-mpu-key"], "foo.txt");
      assert.strictEqual(part!.headers["x-mpu-upload-id"], "upload-123");
      assert.strictEqual(part!.headers["x-mpu-part-number"], "1");
      assert.strictEqual(complete!.headers["x-mpu-key"], "foo.txt");
      assert.strictEqual(complete!.headers["x-mpu-upload-id"], "upload-123");
      assert.strictEqual(complete!.headers["content-type"], "application/json");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends only access and content type with a client token", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* makeTarget({ client: true });
      yield* multipartPut(target, fooTxt, "data", {
        access: "public",
        contentType: "text/plain",
        addRandomSuffix: true,
        allowOverwrite: true,
        cacheControlMaxAge: "1 hour",
      });
      for (const request of yield* requests) {
        assert.strictEqual(
          request.headers.authorization,
          "Bearer vercel_blob_client_fake_token_for_test",
        );
        assert.strictEqual(request.headers["x-vercel-blob-store-id"], "fake");
        assert.strictEqual(request.headers["x-vercel-blob-access"], "public");
        assert.strictEqual(request.headers["x-content-type"], "text/plain");
        assert.isUndefined(request.headers["x-add-random-suffix"]);
        assert.isUndefined(request.headers["x-allow-overwrite"]);
        assert.isUndefined(request.headers["x-cache-control-max-age"]);
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("multipartPut concurrency", () => {
  /** Holds every part until `gate` opens, tracking how many are in the server at once. */
  const gatedParts = Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const active = yield* Ref.make(0);
    const peak = yield* Ref.make(0);
    yield* useMpuHandler(() =>
      Effect.gen(function* () {
        const now = yield* Ref.updateAndGet(active, (n) => n + 1);
        yield* Ref.update(peak, (n) => Math.max(n, now));
        yield* Deferred.await(gate);
        yield* Ref.update(active, (n) => n - 1);
        return undefined;
      }),
    );
    return { gate, active: Ref.get(active), peak: Ref.get(peak) };
  });

  it.effect(
    "uploads at most 8 parts at once by default",
    () =>
      Effect.gen(function* () {
        const { gate, active, peak } = yield* gatedParts;
        const { target } = yield* serverTarget;
        const fiber = yield* Effect.forkChild(
          multipartPut(target, fooTxt, bytesOf(8 * MiB8 + 1), publicAccess),
        );
        yield* eventually(Effect.map(active, (n) => n === 8));
        yield* liveSleep(100);
        assert.strictEqual(yield* active, 8);
        assert.strictEqual((yield* requestsWith("upload")).length, 8);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(fiber);
        assert.strictEqual(yield* peak, 8);
        assert.strictEqual((yield* requestsWith("upload")).length, 9);
        assert.deepStrictEqual(
          (yield* completedParts)[0],
          Array.from({ length: 9 }, (_, index) => ({
            etag: `etag-${index + 1}`,
            partNumber: index + 1,
          })),
        );
      }).pipe(Effect.provide(TestLayer)),
    // Sends 9 real 8 MiB parts, which can outlast the default timeout on a loaded machine.
    30_000,
  );

  it.effect("honours a smaller concurrency", () =>
    Effect.gen(function* () {
      const { gate, active, peak } = yield* gatedParts;
      const { target } = yield* serverTarget;
      const fiber = yield* Effect.forkChild(
        multipartPut(target, fooTxt, bytesOf(2 * MiB8 + 1), { access: "public", concurrency: 2 }),
      );
      yield* eventually(Effect.map(active, (n) => n === 2));
      yield* liveSleep(100);
      assert.strictEqual((yield* requestsWith("upload")).length, 2);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(fiber);
      assert.strictEqual(yield* peak, 2);
      assert.strictEqual((yield* requestsWith("upload")).length, 3);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("multipartPut failures", () => {
  it.effect("a failed part interrupts the parts in flight and does not complete", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const holding = yield* Ref.make(0);
      yield* useMpuHandler((request) =>
        partNumberOf(request) === 2
          ? Effect.as(
              eventually(Effect.map(Ref.get(holding), (n) => n === 2)),
              json(400, { error: { code: "bad_request", message: "bad part" } }),
            )
          : Effect.as(
              Effect.andThen(
                Ref.update(holding, (n) => n + 1),
                Deferred.await(never),
              ),
              undefined,
            ),
      );
      const { target, interrupted } = yield* serverTarget;
      const error = yield* Effect.flip(
        multipartPut(target, fooTxt, bytesOf(2 * MiB8 + 1), publicAccess),
      );
      assert.instanceOf(error, VercelApiError);
      assert.strictEqual(error.operation, "BlobStore.uploadPart");
      assert.instanceOf(error.reason, ApiBadRequest);
      assert.strictEqual(yield* interrupted, 2);
      assert.strictEqual((yield* requestsWith("complete")).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with the body stream's error and does not complete", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      const body = Stream.concat(Stream.make(bytesOf(MiB8 + 3)), Stream.fail(new BodyFailed()));
      const error = yield* Effect.flip(multipartPut(target, fooTxt, body, publicAccess));
      assert.instanceOf(error, BodyFailed);
      assert.strictEqual((yield* requestsWith("complete")).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports a failed complete", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      yield* server.enqueue(
        json(200, { uploadId: "upload-123", key: "foo.txt" }),
        json(200, { etag: "etag-1" }),
        json(412, { error: { code: "precondition_failed" } }),
      );
      const { target } = yield* serverTarget;
      const error = yield* Effect.flip(multipartPut(target, fooTxt, "data", publicAccess));
      assert.strictEqual(error._tag, "BlobPreconditionFailed");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("cancels requests when interrupted: multipart put", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      yield* useMpuHandler(() => Effect.as(Deferred.await(never), undefined));
      const { target, interrupted } = yield* serverTarget;
      const fiber = yield* Effect.forkChild(multipartPut(target, fooTxt, "Big file", publicAccess));
      yield* eventually(Effect.map(requestsWith("upload"), (parts) => parts.length === 1));
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      assert.isTrue(Exit.hasInterrupts(exit));
      assert.strictEqual(yield* interrupted, 1);
      assert.strictEqual((yield* requestsWith("complete")).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("multipartPut upload progress", () => {
  it.effect("reports 0 % after creation and 100 % only after completion", () =>
    Effect.gen(function* () {
      yield* useMpuHandler();
      const { target } = yield* serverTarget;
      const { events, onUploadProgress } = yield* recorder;
      const size = 2 * MiB8 + 10;
      yield* multipartPut(target, fooTxt, bytesOf(size), { access: "public", onUploadProgress });
      // The test clock never moves, so every throttled event is still held back.
      assert.deepStrictEqual(yield* events, [
        { loaded: 0, total: size, percentage: 0 },
        { loaded: size, total: size, percentage: 100 },
      ]);
      const sent = yield* requests;
      const lengths = Object.fromEntries(
        sent.map((request) => [
          request.headers["x-mpu-action"] + (request.headers["x-mpu-part-number"] ?? ""),
          request.headers["x-content-length"],
        ]),
      );
      assert.deepStrictEqual(lengths, {
        create: undefined,
        upload1: String(MiB8),
        upload2: String(MiB8),
        upload3: "10",
        complete: undefined,
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sums the bytes sent by all parts, throttled to one event per 150 ms", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* useMpuHandler(() => Effect.as(Deferred.await(gate), undefined));
      const { target } = yield* serverTarget;
      const { events, onUploadProgress } = yield* recorder;
      const size = 2 * MiB8 + 10;
      const fiber = yield* Effect.forkChild(
        multipartPut(target, fooTxt, bytesOf(size), { access: "public", onUploadProgress }),
      );
      yield* eventually(Effect.map(requestsWith("upload"), (parts) => parts.length === 3));
      // Each part's last chunk only counts once its response arrived (as in the SDK), and the
      // 10-byte part is a single chunk.
      const sentSoFar = 2 * (MiB8 - progressChunkSize);
      yield* TestClock.adjust("149 millis");
      yield* liveSleep(20);
      assert.deepStrictEqual(yield* events, [{ loaded: 0, total: size, percentage: 0 }]);
      yield* TestClock.adjust("1 millis");
      yield* eventually(Effect.map(events, (all) => all.length === 2));
      assert.deepStrictEqual(yield* events, [
        { loaded: 0, total: size, percentage: 0 },
        { loaded: sentSoFar, total: size, percentage: pct(sentSoFar, size) },
      ]);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(fiber);
      assert.deepStrictEqual((yield* events).slice(2), [
        { loaded: size, total: size, percentage: 100 },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports a stream body with total equal to loaded and 0 % until the end", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* useMpuHandler(() => Effect.as(Deferred.await(gate), undefined));
      const { target } = yield* serverTarget;
      const { events, onUploadProgress } = yield* recorder;
      const size = MiB8 + 10;
      const fiber = yield* Effect.forkChild(
        multipartPut(target, fooTxt, Stream.make(bytesOf(size)), {
          access: "public",
          onUploadProgress,
        }),
      );
      yield* eventually(Effect.map(requestsWith("upload"), (parts) => parts.length === 2));
      yield* TestClock.adjust("150 millis");
      yield* eventually(Effect.map(events, (all) => all.length === 2));
      const sentSoFar = MiB8 - progressChunkSize;
      assert.deepStrictEqual(yield* events, [
        { loaded: 0, total: 0, percentage: 0 },
        { loaded: sentSoFar, total: sentSoFar, percentage: 0 },
      ]);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(fiber);
      assert.deepStrictEqual((yield* events).slice(2), [
        { loaded: size, total: size, percentage: 100 },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports one event per finished part where request bodies cannot stream", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* useMpuHandler((request) =>
        partNumberOf(request) === 2
          ? Effect.as(Deferred.await(gate), undefined)
          : Effect.succeed(undefined),
      );
      const { target } = yield* makeTarget({ streamRequestBodies: false });
      const { events, onUploadProgress } = yield* recorder;
      const size = MiB8 + 10;
      const fiber = yield* Effect.forkChild(
        multipartPut(target, fooTxt, bytesOf(size), { access: "public", onUploadProgress }),
      );
      yield* eventually(Effect.map(requestsWith("upload"), (parts) => parts.length === 2));
      yield* liveSleep(50);
      yield* TestClock.adjust("150 millis");
      yield* eventually(Effect.map(events, (all) => all.length === 2));
      assert.deepStrictEqual((yield* events)[1], {
        loaded: MiB8,
        total: size,
        percentage: pct(MiB8, size),
      });
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(fiber);
      assert.deepStrictEqual((yield* events).slice(2), [
        { loaded: size, total: size, percentage: 100 },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports no 100 % when the upload fails", () =>
    Effect.gen(function* () {
      yield* useMpuHandler(() => Effect.succeed(json(403, { error: { code: "forbidden" } })));
      const { target } = yield* serverTarget;
      const { events, onUploadProgress } = yield* recorder;
      yield* Effect.flip(
        multipartPut(target, fooTxt, "data", { access: "public", onUploadProgress }),
      );
      assert.deepStrictEqual(yield* events, [{ loaded: 0, total: 4, percentage: 0 }]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
