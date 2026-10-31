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
import { Deferred, Effect, Exit, Fiber, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import type { MultipartWriteOptions } from "./multipart.ts";

import {
  BlobPathname,
  ClientToken,
  ETag,
  MultipartUpload,
  PartNumber,
  UploadedPart,
} from "../contracts/blob-domain.ts";
import { BlobRequestAuth, blobRequester } from "./blob-request.ts";
import {
  clientMultipartWriteOptions,
  completeMultipartUpload,
  createMultipartUpload,
  maxConcurrentPartUploads,
  serverMultipartWriteOptions,
  uploadPart,
} from "./multipart.ts";
import { storeIdFromClientToken } from "./store-id.ts";

const readWriteToken = "vercel_blob_rw_12345fakeStoreId_30FakeRandomCharacters12345678";
const clientToken = ClientToken.make("vercel_blob_client_fake_token_for_test");
const BLOB_STORE_BASE_URL = "https://storeId.public.blob.vercel-storage.com";

const serverDomainErrors = [
  "BlobStoreUnavailable",
  "BlobOidcEnvironmentNotAllowed",
  "BlobPreconditionFailed",
  "BlobUploadRejected",
] as const;

const clientDomainErrors = [
  "BlobStoreUnavailable",
  "BlobUploadRejected",
  "BlobPreconditionFailed",
  "BlobClientTokenNotAllowed",
] as const;

const targetWith = (options: {
  readonly token: string;
  readonly storeId: string;
  readonly service: string;
  readonly writeOptions: MultipartWriteOptions;
  readonly domainErrors: ReadonlyArray<
    (typeof serverDomainErrors | typeof clientDomainErrors)[number]
  >;
}) =>
  Effect.gen(function* () {
    const server = yield* TestHttpServer;
    const httpClient = yield* HttpClient.HttpClient;
    return {
      requester: blobRequester({
        httpClient,
        apiUrl: new URL(`${server.url}/api/blob`),
        apiVersion: "13",
        retries: 0,
        sendContentLength: false,
        headers: {},
      }),
      auth: Effect.succeed(
        BlobRequestAuth.Bearer({ token: Redacted.make(options.token), storeId: options.storeId }),
      ),
      service: options.service,
      domainErrors: options.domainErrors,
      writeOptions: options.writeOptions,
    };
  });

const serverTarget = targetWith({
  token: readWriteToken,
  storeId: "12345fakeStoreId",
  service: "BlobStore",
  writeOptions: serverMultipartWriteOptions,
  domainErrors: serverDomainErrors,
});

const clientTarget = targetWith({
  token: clientToken,
  storeId: Option.getOrThrow(storeIdFromClientToken(clientToken)),
  service: "BlobClient",
  writeOptions: clientMultipartWriteOptions,
  domainErrors: clientDomainErrors,
});

const TestLayer = Layer.mergeAll(TestHttpServerLive(), FetchHttpClient.layer);

const requests = Effect.flatMap(Effect.service(TestHttpServer), (server) => server.requests);

const enqueue = (...responses: ReadonlyArray<TestHttpResponse>) =>
  Effect.flatMap(Effect.service(TestHttpServer), (server) => server.enqueue(...responses));

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The Blob protocol headers of a request, without the request id (checked by shape). */
const protocolHeaders = (request: TestHttpRequest): Record<string, string> =>
  Object.fromEntries(
    Object.entries(request.headers).filter(
      ([name]) =>
        (name.startsWith("x-") && name !== "x-api-blob-request-id") || name === "authorization",
    ),
  );

const pathname = (value: string) => BlobPathname.make(value);
const partNumber = (value: number) => PartNumber.make(value);

const upload = (fields: Partial<ConstructorParameters<typeof MultipartUpload>[0]> = {}) =>
  new MultipartUpload({
    pathname: pathname("foo.txt"),
    key: "foo.txt",
    uploadId: "upload-123",
    access: "public",
    ...fields,
  });

const mockedCompleteResponse = {
  url: `${BLOB_STORE_BASE_URL}/foo.txt`,
  downloadUrl: `${BLOB_STORE_BASE_URL}/foo.txt?download=1`,
  pathname: "foo.txt",
  contentType: "text/plain",
  contentDisposition: 'attachment; filename="foo.txt"',
  // The SDK's mock has no etag; API version 13 always sends one, and the result requires it.
  etag: '"abc123"',
};

describe("createMultipartUpload", () => {
  const mockedCreateResponse = { uploadId: "upload-123", key: "foo.txt" };

  it.effect.each(["private", "public"] as const)(
    "should create a multipart upload with %s access",
    (access) =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCreateResponse));
        const target = yield* serverTarget;
        const handle = yield* createMultipartUpload(target, pathname("foo.txt"), { access });
        assert.deepStrictEqual(
          handle,
          new MultipartUpload({
            pathname: pathname("foo.txt"),
            key: "foo.txt",
            uploadId: "upload-123",
            access,
          }),
        );
        const [request] = yield* requests;
        assert.strictEqual(request!.method, "POST");
        assert.strictEqual(request!.url, "/api/blob/mpu?pathname=foo.txt");
        assert.strictEqual(request!.headers["x-vercel-blob-access"], access);
        assert.strictEqual(request!.headers["x-mpu-action"], "create");
        assert.strictEqual(request!.body.length, 0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sends every put option and keeps all but ifMatch on the handle", () =>
    Effect.gen(function* () {
      yield* enqueue(json(200, mockedCreateResponse));
      const target = yield* serverTarget;
      const handle = yield* createMultipartUpload(target, pathname("a b/ü.txt"), {
        access: "private",
        addRandomSuffix: false,
        contentType: "text/plain",
        cacheControlMaxAge: "2 minutes",
        ifMatch: ETag.make('"etag"'),
      });
      assert.deepStrictEqual(
        handle,
        new MultipartUpload({
          pathname: pathname("a b/ü.txt"),
          key: "foo.txt",
          uploadId: "upload-123",
          access: "private",
          addRandomSuffix: false,
          contentType: "text/plain",
          cacheControlMaxAge: 120,
        }),
      );
      const [request] = yield* requests;
      assert.strictEqual(
        request!.url,
        `/api/blob/mpu?${new URLSearchParams({ pathname: "a b/ü.txt" })}`,
      );
      assert.deepStrictEqual(protocolHeaders(request!), {
        authorization: `Bearer ${readWriteToken}`,
        "x-api-blob-request-attempt": "0",
        "x-vercel-blob-store-id": "12345fakeStoreId",
        "x-api-version": "13",
        "x-mpu-action": "create",
        "x-vercel-blob-access": "private",
        "x-add-random-suffix": "0",
        "x-allow-overwrite": "1",
        "x-content-type": "text/plain",
        "x-cache-control-max-age": "120",
        "x-if-match": '"etag"',
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps only the options a client token may set", () =>
    Effect.gen(function* () {
      yield* enqueue(json(200, mockedCreateResponse));
      const target = yield* clientTarget;
      const handle = yield* createMultipartUpload(target, pathname("foo.txt"), {
        access: "public",
        contentType: "text/plain",
        addRandomSuffix: true,
        cacheControlMaxAge: "2 minutes",
      });
      assert.deepStrictEqual(handle, upload({ key: "foo.txt", contentType: "text/plain" }));
      const [request] = yield* requests;
      assert.strictEqual(request!.headers["x-content-type"], "text/plain");
      assert.isUndefined(request!.headers["x-add-random-suffix"]);
      assert.isUndefined(request!.headers["x-cache-control-max-age"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports failures under the service's operation name", () =>
    Effect.gen(function* () {
      yield* enqueue(json(403, { error: { code: "forbidden" } }));
      const target = yield* serverTarget;
      const error = yield* Effect.flip(
        createMultipartUpload(target, pathname("foo.txt"), { access: "public" }),
      );
      assert.instanceOf(error, VercelApiError);
      assert.strictEqual(error.operation, "BlobStore.createMultipartUpload");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("uploadPart", () => {
  const mockedUploadPartResponse = { etag: "etag-123" };

  it.effect.each(["private", "public"] as const)("should upload a part with %s access", (access) =>
    Effect.gen(function* () {
      yield* enqueue(json(200, mockedUploadPartResponse));
      const target = yield* serverTarget;
      const part = yield* uploadPart(target, upload({ access }), partNumber(1), "Test Body");
      assert.deepStrictEqual(
        part,
        new UploadedPart({ etag: "etag-123", partNumber: partNumber(1) }),
      );
      const [request] = yield* requests;
      assert.strictEqual(request!.method, "POST");
      assert.strictEqual(request!.url, "/api/blob/mpu?pathname=foo.txt");
      assert.strictEqual(request!.headers["x-vercel-blob-access"], access);
      assert.strictEqual(request!.text, "Test Body");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resends the handle's options, URI-encodes the key and numbers the part", () =>
    Effect.gen(function* () {
      yield* enqueue(json(200, mockedUploadPartResponse));
      const target = yield* serverTarget;
      const bytes = new Uint8Array([1, 2, 3]);
      yield* uploadPart(
        target,
        upload({
          key: "folder/ü file.txt",
          addRandomSuffix: true,
          allowOverwrite: true,
          contentType: "text/plain",
          cacheControlMaxAge: 120,
        }),
        partNumber(7),
        bytes,
      );
      const [request] = yield* requests;
      assert.deepStrictEqual(protocolHeaders(request!), {
        authorization: `Bearer ${readWriteToken}`,
        "x-api-blob-request-attempt": "0",
        "x-vercel-blob-store-id": "12345fakeStoreId",
        "x-api-version": "13",
        "x-mpu-action": "upload",
        "x-mpu-key": "folder%2F%C3%BC%20file.txt",
        "x-mpu-upload-id": "upload-123",
        "x-mpu-part-number": "7",
        "x-vercel-blob-access": "public",
        "x-add-random-suffix": "1",
        "x-allow-overwrite": "1",
        "x-content-type": "text/plain",
        "x-cache-control-max-age": "120",
      });
      assert.deepStrictEqual(request!.body, bytes);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("completeMultipartUpload", () => {
  it.effect.each(["private", "public"] as const)(
    "should complete a multipart upload with %s access",
    (access) =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCompleteResponse));
        const target = yield* serverTarget;
        const blob = yield* completeMultipartUpload(target, upload({ access }), [
          new UploadedPart({ partNumber: partNumber(1), etag: "etag-123" }),
        ]);
        assert.strictEqual(blob.url.href, new URL(`${BLOB_STORE_BASE_URL}/foo.txt`).href);
        assert.strictEqual(
          blob.downloadUrl.href,
          new URL(`${BLOB_STORE_BASE_URL}/foo.txt?download=1`).href,
        );
        assert.strictEqual(blob.pathname, "foo.txt");
        assert.strictEqual(blob.contentType, "text/plain");
        assert.strictEqual(blob.contentDisposition, 'attachment; filename="foo.txt"');
        const [request] = yield* requests;
        assert.strictEqual(request!.method, "POST");
        assert.strictEqual(request!.url, "/api/blob/mpu?pathname=foo.txt");
        assert.strictEqual(request!.headers["x-vercel-blob-access"], access);
        assert.strictEqual(request!.headers["content-type"], "application/json");
        assert.strictEqual(request!.text, '[{"etag":"etag-123","partNumber":1}]');
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe("client token request sequences", () => {
  // Port of client.browser.test.ts "should upload a file using the manual functions" and "…using
  // the uploader": the handle plays the uploader's role, so both make the same four requests.
  const scriptSequence = enqueue(
    json(200, { key: "key", uploadId: "uploadId" }),
    json(200, { etag: "etag1" }),
    json(200, { etag: "etag2" }),
    json(200, { ...mockedCompleteResponse, url: `${BLOB_STORE_BASE_URL}/foo.txt` }),
  );

  const common = {
    authorization: "Bearer vercel_blob_client_fake_token_for_test",
    "x-api-blob-request-attempt": "0",
    "x-vercel-blob-store-id": "fake",
    "x-api-version": "13",
    "x-vercel-blob-access": "public",
  };

  const assertSequence = Effect.gen(function* () {
    const sent = yield* requests;
    assert.strictEqual(sent.length, 4);
    for (const request of sent) {
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, "/api/blob/mpu?pathname=foo.txt");
      assert.match(request.headers["x-api-blob-request-id"] ?? "", /^fake:\d+:[0-9a-f]+$/);
    }
    const [create, part1, part2, complete] = sent;
    assert.deepStrictEqual(protocolHeaders(create!), { ...common, "x-mpu-action": "create" });
    assert.strictEqual(create!.body.length, 0);
    const partHeaders = (n: string) => ({
      ...common,
      "x-mpu-action": "upload",
      "x-mpu-key": "key",
      "x-mpu-upload-id": "uploadId",
      "x-mpu-part-number": n,
    });
    assert.deepStrictEqual(protocolHeaders(part1!), partHeaders("1"));
    assert.strictEqual(part1!.text, "data1");
    assert.deepStrictEqual(protocolHeaders(part2!), partHeaders("2"));
    assert.strictEqual(part2!.text, "data2");
    assert.deepStrictEqual(protocolHeaders(complete!), {
      ...common,
      "x-mpu-action": "complete",
      "x-mpu-key": "key",
      "x-mpu-upload-id": "uploadId",
    });
    assert.strictEqual(complete!.headers["content-type"], "application/json");
    assert.strictEqual(
      complete!.text,
      JSON.stringify([
        { etag: "etag1", partNumber: 1 },
        { etag: "etag2", partNumber: 2 },
      ]),
    );
  });

  it.effect("should upload a file using the manual functions", () =>
    Effect.gen(function* () {
      yield* scriptSequence;
      const target = yield* clientTarget;
      const handle = yield* createMultipartUpload(target, pathname("foo.txt"), {
        access: "public",
      });
      assert.strictEqual(handle.uploadId, "uploadId");
      assert.strictEqual(handle.key, "key");
      const part1 = yield* uploadPart(target, handle, partNumber(1), "data1");
      assert.deepStrictEqual(part1, new UploadedPart({ etag: "etag1", partNumber: partNumber(1) }));
      const part2 = yield* uploadPart(target, handle, partNumber(2), "data2");
      assert.deepStrictEqual(part2, new UploadedPart({ etag: "etag2", partNumber: partNumber(2) }));
      const blob = yield* completeMultipartUpload(target, handle, [part1, part2]);
      assert.strictEqual(blob.pathname, "foo.txt");
      assert.strictEqual(blob.url.href, new URL(`${BLOB_STORE_BASE_URL}/foo.txt`).href);
      assert.strictEqual(blob.contentType, "text/plain");
      assert.strictEqual(blob.contentDisposition, 'attachment; filename="foo.txt"');
      yield* assertSequence;
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("should upload a file using a handle serialized in between (the uploader)", () =>
    Effect.gen(function* () {
      yield* scriptSequence;
      const target = yield* clientTarget;
      const created = yield* createMultipartUpload(target, pathname("foo.txt"), {
        access: "public",
      });
      const codec = Schema.fromJsonString(MultipartUpload);
      const handle = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(created));
      const part1 = yield* uploadPart(target, handle, partNumber(1), "data1");
      const part2 = yield* uploadPart(target, handle, partNumber(2), "data2");
      yield* completeMultipartUpload(target, handle, [part1, part2]);
      yield* assertSequence;
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("interruption", () => {
  // Port of the SDK's "cancels requests with an abort controller" cases for the manual functions.
  const operations = [
    [
      "create multipart upload",
      (target: Effect.Success<typeof serverTarget>) =>
        Effect.asVoid(
          createMultipartUpload(target, pathname("big-file.txt"), { access: "public" }),
        ),
    ],
    [
      "upload part",
      (target: Effect.Success<typeof serverTarget>) =>
        Effect.asVoid(
          uploadPart(
            target,
            upload({ key: "big-file.txt", uploadId: "1" }),
            partNumber(1),
            "Big file",
          ),
        ),
    ],
    [
      "complete multipart upload",
      (target: Effect.Success<typeof serverTarget>) =>
        Effect.asVoid(
          completeMultipartUpload(target, upload({ key: "big-file.txt", uploadId: "1" }), []),
        ),
    ],
  ] as const;

  it.effect.each(operations)("cancels the request when interrupted: %s", ([, operation]) =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const never = yield* Deferred.make<TestHttpResponse>();
      yield* server.setHandler(() => Deferred.await(never));
      const target = yield* serverTarget;
      const fiber = yield* Effect.forkChild(operation(target));
      while ((yield* server.requests).length === 0) {
        yield* TestClock.withLive(Effect.sleep("5 millis"));
      }
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      assert.isTrue(Exit.hasInterrupts(exit));
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("maxConcurrentPartUploads", () => {
  it("is 8 outside browsers and 6 where window is defined, as in the SDK", () => {
    assert.strictEqual(maxConcurrentPartUploads(), 8);
    const global = globalThis as { window?: unknown };
    global.window = {};
    try {
      assert.strictEqual(maxConcurrentPartUploads(), 6);
    } finally {
      delete global.window;
    }
  });
});
