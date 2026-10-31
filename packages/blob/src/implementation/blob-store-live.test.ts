import type { TestHttpResponse } from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import { vercelOidcFromToken } from "@panorama-industries/effect-vercel-core";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type { BlobAccess, StoreId, UploadProgress } from "../contracts/blob-domain.ts";
import type { GetBlobResult } from "../contracts/blob-domain.ts";
import type { PutImageOptions } from "../contracts/blob-store.ts";

import {
  BlobPathname,
  ETag,
  maximumPathnameLength,
  MultipartUpload,
  PartNumber,
} from "../contracts/blob-domain.ts";
import { ImageFormat, ImageQuality, ImageWidth } from "../contracts/blob-store.ts";
import { BlobStore } from "../contracts/blob-store.ts";
import { blobConfigLayer } from "./blob-config-live.ts";
import { BlobStoreLive } from "./blob-store-live.ts";

const token = "vercel_blob_rw_12345fakeStoreId_30FakeRandomCharacters12345678";
const BLOB_STORE_BASE_URL = "https://storeId.public.blob.vercel-storage.com";

const mockedFileMeta = {
  url: `${BLOB_STORE_BASE_URL}/foo-id.txt`,
  downloadUrl: `${BLOB_STORE_BASE_URL}/foo-id.txt?download=1`,
  size: 12345,
  uploadedAt: "2023-05-04T15:12:07.818Z",
  pathname: "foo.txt",
  contentType: "text/plain",
  contentDisposition: 'attachment; filename="foo.txt"',
  // The SDK's mock omits it (`cacheControl: undefined`); the API always sends it and our decoder
  // requires it.
  cacheControl: "public, max-age=31536000",
  etag: '"abc123"',
};

const mockedFileMetaPut = {
  url: mockedFileMeta.url,
  downloadUrl: mockedFileMeta.downloadUrl,
  pathname: mockedFileMeta.pathname,
  contentType: mockedFileMeta.contentType,
  contentDisposition: mockedFileMeta.contentDisposition,
  etag: mockedFileMeta.etag,
};

const mockedFileMetaList = {
  url: mockedFileMeta.url,
  downloadUrl: mockedFileMeta.downloadUrl,
  pathname: mockedFileMeta.pathname,
  size: mockedFileMeta.size,
  uploadedAt: mockedFileMeta.uploadedAt,
  etag: mockedFileMeta.etag,
};

const mockedCopyResult = {
  url: `${BLOB_STORE_BASE_URL}/destination.txt`,
  downloadUrl: `${BLOB_STORE_BASE_URL}/destination.txt?download=1`,
  pathname: "destination.txt",
  contentType: "text/plain",
  contentDisposition: 'attachment; filename="destination.txt"',
  etag: '"def456"',
};

const mockedOptimizedBlob = {
  url: `${BLOB_STORE_BASE_URL}/avatar-id.webp`,
  downloadUrl: `${BLOB_STORE_BASE_URL}/avatar-id.webp?download=1`,
  pathname: "avatar.webp",
  contentType: "image/webp",
  contentDisposition: 'inline; filename="avatar.webp"',
  etag: '"abc123"',
};

/**
 * Sends requests for `*.blob.vercel-storage.com` hosts to the test server under
 * `/__blob/<host>/…`, like undici's `MockAgent` for the store hosts in the SDK's tests.
 */
const blobHostRedirect = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const server = yield* TestHttpServer;
    const client = yield* HttpClient.HttpClient;
    return HttpClient.mapRequest(client, (request) => {
      const match = /^https:\/\/([^/]+\.blob\.vercel-storage\.com)(\/.*)?$/.exec(request.url);
      return match === null
        ? request
        : HttpClientRequest.setUrl(request, `${server.url}/__blob/${match[1]}${match[2] ?? ""}`);
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

interface StoreLayerOptions {
  readonly retries?: number;
  /** Defaults to the test server's `/api/blob`. */
  readonly apiUrl?: (serverUrl: string) => string;
  readonly blobBaseUrl?: (serverUrl: string) => (storeId: StoreId, access: BlobAccess) => URL;
  readonly token?: string;
  /** Use OIDC with this store id instead of a read-write token. */
  readonly storeId?: string;
  readonly oidcToken?: string;
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient, never, TestHttpServer>;
}

const storeLayer = (options: StoreLayerOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const config = blobConfigLayer({
        apiUrl: options.apiUrl?.(server.url) ?? `${server.url}/api/blob`,
        ...(options.storeId === undefined
          ? { token: options.token ?? token }
          : { storeId: options.storeId }),
        retries: options.retries ?? 0,
        blobBaseUrl: options.blobBaseUrl?.(server.url),
      });
      return BlobStoreLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            config,
            options.httpClient ?? blobHostRedirect,
            vercelOidcFromToken(Redacted.make(options.oidcToken ?? "oidc-token")),
          ),
        ),
      );
    }),
  ).pipe(Layer.provideMerge(TestHttpServerLive()));

const TestLayer = storeLayer();

const requests = Effect.flatMap(Effect.service(TestHttpServer), (server) => server.requests);

const lastRequest = Effect.map(requests, (all) => {
  const request = all.at(-1);
  assert.isDefined(request);
  return request!;
});

const enqueue = (...responses: ReadonlyArray<TestHttpResponse>) =>
  Effect.flatMap(Effect.service(TestHttpServer), (server) => server.enqueue(...responses));

const json = (status: number, body: unknown): TestHttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const errorBody = (status: number, error: Record<string, string>) => json(status, { error });

const pathname = (value: string) => BlobPathname.make(value);

const etag = (value: string) => ETag.make(value);

const defectMessage = <A, E>(exit: Exit.Exit<A, E>): string => {
  assert.isTrue(Exit.isFailure(exit));
  const reason = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason) : undefined;
  assert.isDefined(reason);
  return reason!.defect instanceof Error ? reason!.defect.message : String(reason!.defect);
};

/** Asserts that a tagged value has `tag` and narrows it. */
const expectTagged = <A extends { readonly _tag: string }, T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  assert.isTrue(Predicate.isTagged(value, tag), `expected ${tag}, got ${value._tag}`);
  return value as Extract<A, { readonly _tag: T }>;
};

const found = (result: GetBlobResult) => expectTagged(result, "Found");

const notModified = (result: GetBlobResult) => expectTagged(result, "NotModified");

const assertPutResult = (
  result: {
    readonly url: URL;
    readonly downloadUrl: URL;
    readonly pathname: string;
    readonly contentType: string;
    readonly contentDisposition: string;
    readonly etag: string;
  },
  expected: typeof mockedFileMetaPut,
) => {
  // `URL` normalizes the host to lower case.
  assert.strictEqual(result.url.href, new URL(expected.url).href);
  assert.strictEqual(result.downloadUrl.href, new URL(expected.downloadUrl).href);
  assert.strictEqual(result.pathname, expected.pathname);
  assert.strictEqual(result.contentType, expected.contentType);
  assert.strictEqual(result.contentDisposition, expected.contentDisposition);
  assert.strictEqual(result.etag, expected.etag);
};

const blobResponse = (body: string, headers: Record<string, string> = {}): TestHttpResponse => ({
  status: 200,
  headers: { "content-type": "text/plain", "content-length": String(body.length), ...headers },
  body,
});

describe("BlobStoreLive", () => {
  describe("head", () => {
    it.effect("returns blob metadata", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMeta));
        const store = yield* BlobStore;
        const result = yield* store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`);
        assert.strictEqual(
          result.url.href,
          "https://storeid.public.blob.vercel-storage.com/foo-id.txt",
        );
        assert.strictEqual(
          result.downloadUrl.href,
          "https://storeid.public.blob.vercel-storage.com/foo-id.txt?download=1",
        );
        assert.strictEqual(result.pathname, "foo.txt");
        assert.strictEqual(result.size, 12345);
        assert.strictEqual(DateTime.formatIso(result.uploadedAt), "2023-05-04T15:12:07.818Z");
        assert.strictEqual(result.contentType, "text/plain");
        assert.strictEqual(result.contentDisposition, 'attachment; filename="foo.txt"');
        assert.strictEqual(result.cacheControl, "public, max-age=31536000");
        assert.strictEqual(result.etag, '"abc123"');
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "GET");
        assert.strictEqual(
          request.url,
          "/api/blob?url=https%3A%2F%2FstoreId.public.blob.vercel-storage.com%2Ffoo-id.txt",
        );
        assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sends a URL locator as its href", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMeta));
        const store = yield* BlobStore;
        yield* store.head(new URL(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const request = yield* lastRequest;
        assert.strictEqual(
          request.url,
          "/api/blob?url=https%3A%2F%2Fstoreid.public.blob.vercel-storage.com%2Ffoo-id.txt",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("uses the OIDC token and the configured store id", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMeta));
        const store = yield* BlobStore;
        const result = yield* store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`);
        assert.strictEqual(result.pathname, "foo.txt");
        const request = yield* lastRequest;
        assert.strictEqual(request.headers.authorization, "Bearer oidc-from-option");
        assert.strictEqual(request.headers["x-vercel-blob-store-id"], "customStore");
      }).pipe(
        Effect.provide(storeLayer({ storeId: "store_customStore", oidcToken: "oidc-from-option" })),
      ),
    );

    it.effect("fails with BlobNotFound for a blob that does not exist", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(404, { code: "not_found", message: "Not found" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        assert.strictEqual(error._tag, "BlobNotFound");
        assert.deepInclude(error, { locator: `${BLOB_STORE_BASE_URL}/foo-id.txt` });
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with ApiForbidden for an invalid token", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(403, { code: "forbidden" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(failure.reason._tag, "ApiForbidden");
        assert.strictEqual(
          failure.reason.message,
          "Access denied, please provide a valid token for this resource.",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with a generic error when the API returns a 500", () =>
      Effect.gen(function* () {
        yield* enqueue({ status: 500, body: "Invalid token" });
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(failure.reason._tag, "ApiServerError");
        assert.strictEqual(
          failure.reason.message,
          "Unknown error, please visit https://vercel.com/help.",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with BlobStoreUnavailable when the store is suspended", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(403, { code: "store_suspended" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const failure = expectTagged(error, "BlobStoreUnavailable");
        assert.strictEqual(failure.reason._tag, "BlobStoreSuspended");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with BlobStoreUnavailable when the store does not exist", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(403, { code: "store_not_found" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const failure = expectTagged(error, "BlobStoreUnavailable");
        assert.strictEqual(failure.reason._tag, "BlobStoreNotFound");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with ApiServerError when the service is unavailable", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(502, { code: "service_unavailable" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(failure.reason._tag, "ApiServerError");
        assert.strictEqual(
          failure.reason.message,
          "The blob service is currently not available. Please try again.",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reports a domain error head does not declare as VercelApiError", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(412, { code: "precondition_failed" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const failure = expectTagged(error, "VercelApiError");
        assert.deepStrictEqual(failure.errorCode, Option.some("precondition_failed"));
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("del", () => {
    it.effect("deletes a single blob", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, [mockedFileMeta.url]));
        const store = yield* BlobStore;
        const result = yield* store.del(`${BLOB_STORE_BASE_URL}/foo-id.txt`);
        assert.isUndefined(result);
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.url, "/api/blob/delete");
        assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
        assert.strictEqual(request.headers["content-type"], "application/json");
        assert.notProperty(request.headers, "x-if-match");
        assert.strictEqual(
          request.text,
          '{"urls":["https://storeId.public.blob.vercel-storage.com/foo-id.txt"]}',
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("deletes several blobs in one request", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, [mockedFileMeta.url, mockedFileMeta.url]));
        const store = yield* BlobStore;
        const result = yield* store.delMany([
          `${BLOB_STORE_BASE_URL}/foo-id1.txt`,
          new URL(`${BLOB_STORE_BASE_URL}/foo-id2.txt`),
        ]);
        assert.isUndefined(result);
        const request = yield* lastRequest;
        assert.strictEqual(request.url, "/api/blob/delete");
        assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
        assert.strictEqual(
          request.text,
          '{"urls":["https://storeId.public.blob.vercel-storage.com/foo-id1.txt","https://storeid.public.blob.vercel-storage.com/foo-id2.txt"]}',
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with ApiForbidden for an invalid token", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(403, { code: "forbidden" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.del(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(failure.reason._tag, "ApiForbidden");
        assert.strictEqual(
          failure.reason.message,
          "Access denied, please provide a valid token for this resource.",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with a generic error when the API returns a 500", () =>
      Effect.gen(function* () {
        yield* enqueue({ status: 500, body: "Invalid token" });
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.del(`${BLOB_STORE_BASE_URL}/foo-id.txt`));
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(
          failure.reason.message,
          "Unknown error, please visit https://vercel.com/help.",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sends x-if-match when ifMatch is set", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, null));
        const store = yield* BlobStore;
        yield* store.del(`${BLOB_STORE_BASE_URL}/foo-id.txt`, { ifMatch: etag('"abc123"') });
        const request = yield* lastRequest;
        assert.strictEqual(request.headers["x-if-match"], '"abc123"');
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with BlobPreconditionFailed on a 412", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(412, { code: "precondition_failed" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(
          store.del(`${BLOB_STORE_BASE_URL}/foo-id.txt`, { ifMatch: etag('"old-etag"') }),
        );
        assert.strictEqual(error._tag, "BlobPreconditionFailed");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("delMany reports precondition_failed as VercelApiError", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(412, { code: "precondition_failed" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.delMany([`${BLOB_STORE_BASE_URL}/foo-id.txt`]));
        assert.strictEqual(error._tag, "VercelApiError");
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("list", () => {
    it.effect("returns a page of blobs", () =>
      Effect.gen(function* () {
        yield* enqueue(
          json(200, {
            blobs: [mockedFileMetaList, mockedFileMetaList],
            cursor: "cursor-123",
            hasMore: true,
          }),
        );
        const store = yield* BlobStore;
        const page = yield* store.list({ cursor: "cursor-abc", limit: 10, prefix: "test-prefix" });
        assert.strictEqual(page.blobs.length, 2);
        for (const blob of page.blobs) {
          assert.strictEqual(
            blob.downloadUrl.href,
            "https://storeid.public.blob.vercel-storage.com/foo-id.txt?download=1",
          );
          assert.strictEqual(blob.etag, '"abc123"');
          assert.strictEqual(blob.pathname, "foo.txt");
          assert.strictEqual(blob.size, 12345);
          assert.strictEqual(DateTime.formatIso(blob.uploadedAt), "2023-05-04T15:12:07.818Z");
          assert.strictEqual(
            blob.url.href,
            "https://storeid.public.blob.vercel-storage.com/foo-id.txt",
          );
        }
        assert.deepStrictEqual(page.cursor, Option.some("cursor-123"));
        assert.isTrue(page.hasMore);
        assert.deepStrictEqual(page.folders, []);
        const request = yield* lastRequest;
        assert.strictEqual(request.url, "/api/blob?limit=10&prefix=test-prefix&cursor=cursor-abc");
        assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with ApiForbidden for an invalid token", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(403, { code: "forbidden" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.list());
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(failure.reason._tag, "ApiForbidden");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with BlobOidcEnvironmentNotAllowed when OIDC is off for the environment", () =>
      Effect.gen(function* () {
        const message =
          'OIDC is enabled for this project, but not for the "production" environment.';
        yield* enqueue(errorBody(403, { code: "forbidden", message }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.list());
        assert.strictEqual(error._tag, "BlobOidcEnvironmentNotAllowed");
        assert.deepInclude(error, { message });
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with a generic error when the API returns a 500", () =>
      Effect.gen(function* () {
        yield* enqueue({ status: 500, body: "Invalid token" });
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.list());
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(
          failure.reason.message,
          "Unknown error, please visit https://vercel.com/help.",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("passes the mode and returns folders", () =>
      Effect.gen(function* () {
        yield* enqueue(
          json(200, { blobs: [mockedFileMetaList], folders: ["foo", "bar"], hasMore: false }),
        );
        const store = yield* BlobStore;
        const page = yield* store.list({ mode: "folded" });
        assert.strictEqual(page.blobs.length, 1);
        assert.deepStrictEqual(page.cursor, Option.none());
        assert.deepStrictEqual(page.folders, ["foo", "bar"]);
        assert.isFalse(page.hasMore);
        const request = yield* lastRequest;
        assert.strictEqual(request.url, "/api/blob?mode=folded");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("returns the etag of each blob", () =>
      Effect.gen(function* () {
        yield* enqueue(
          json(200, {
            blobs: [
              { ...mockedFileMetaList, etag: '"blob1etag"' },
              { ...mockedFileMetaList, etag: '"blob2etag"' },
            ],
            hasMore: false,
          }),
        );
        const store = yield* BlobStore;
        const page = yield* store.list();
        assert.deepStrictEqual(
          page.blobs.map((blob) => blob.etag),
          ['"blob1etag"', '"blob2etag"'],
        );
        assert.strictEqual((yield* lastRequest).url, "/api/blob");
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("listAll", () => {
    it.effect("follows the cursor while there are more pages", () =>
      Effect.gen(function* () {
        yield* enqueue(
          json(200, {
            blobs: [{ ...mockedFileMetaList, pathname: "a.txt" }],
            cursor: "c1",
            hasMore: true,
          }),
          json(200, { blobs: [], cursor: "c2", hasMore: true }),
          json(200, {
            blobs: [
              { ...mockedFileMetaList, pathname: "b.txt" },
              { ...mockedFileMetaList, pathname: "c.txt" },
            ],
            hasMore: false,
          }),
        );
        const store = yield* BlobStore;
        const blobs = yield* Stream.runCollect(store.listAll({ prefix: "p", limit: 2 }));
        assert.deepStrictEqual(
          blobs.map((blob) => blob.pathname),
          ["a.txt", "b.txt", "c.txt"],
        );
        assert.deepStrictEqual(
          (yield* requests).map((request) => request.url),
          [
            "/api/blob?limit=2&prefix=p",
            "/api/blob?limit=2&prefix=p&cursor=c1",
            "/api/blob?limit=2&prefix=p&cursor=c2",
          ],
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("stops when a page has more but no cursor", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, { blobs: [mockedFileMetaList], hasMore: true }));
        const store = yield* BlobStore;
        const blobs = yield* Stream.runCollect(store.listAll());
        assert.strictEqual(blobs.length, 1);
        assert.strictEqual((yield* requests).length, 1);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fetches pages only as the stream is read", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, { blobs: [mockedFileMetaList], cursor: "c1", hasMore: true }));
        const store = yield* BlobStore;
        const blobs = yield* Stream.runCollect(Stream.take(store.listAll(), 1));
        assert.strictEqual(blobs.length, 1);
        assert.strictEqual((yield* requests).length, 1);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails the stream with the page's error", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(403, { code: "forbidden" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(Stream.runCollect(store.listAll()));
        assert.strictEqual(error._tag, "VercelApiError");
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("put", () => {
    const recorder = Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<UploadProgress>>([]);
      return {
        events: Ref.get(events),
        onUploadProgress: (progress: UploadProgress) =>
          Ref.update(events, (all) => [...all, progress]),
      };
    });

    it.effect("reports upload progress", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        const { events, onUploadProgress } = yield* recorder;
        const result = yield* store.put(pathname("progress.txt"), "Test Body", {
          access: "public",
          onUploadProgress,
        });
        assertPutResult(result, mockedFileMetaPut);
        // The SDK's throttle delays its 100 % event past the end of its test; ours reports it at once.
        assert.deepStrictEqual(yield* events, [
          { loaded: 0, total: 9, percentage: 0 },
          { loaded: 9, total: 9, percentage: 100 },
        ]);
        assert.strictEqual((yield* lastRequest).headers["x-content-length"], "9");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("throttles chunk progress events to one per 100 ms", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        const { events, onUploadProgress } = yield* recorder;
        const chunk = 64 * 1024;
        const body = new Uint8Array(chunk * 4);
        yield* store.put(pathname("big.bin"), body, { access: "public", onUploadProgress });
        // The 25/50/75 % chunk events fall inside the first 100 ms window (the test clock does not
        // move), so the throttle holds them back; 0 % and 100 % are never delayed.
        assert.deepStrictEqual(
          (yield* events).map((event) => event.percentage),
          [0, 100],
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reports the latest chunk event once the 100 ms interval ends", () =>
      Effect.gen(function* () {
        const server = yield* TestHttpServer;
        const gate = yield* Deferred.make<void>();
        yield* server.setHandler(() =>
          Effect.as(Deferred.await(gate), json(200, mockedFileMetaPut)),
        );
        const store = yield* BlobStore;
        const { events, onUploadProgress } = yield* recorder;
        const fiber = yield* Effect.forkChild(
          store.put(pathname("big.bin"), new Uint8Array(64 * 1024 * 4), {
            access: "public",
            onUploadProgress,
          }),
        );
        // The server records the request once the whole body arrived.
        while ((yield* server.requests).length === 0) {
          yield* TestClock.withLive(Effect.sleep("5 millis"));
        }
        yield* TestClock.adjust("99 millis");
        assert.deepStrictEqual(
          (yield* events).map((event) => event.percentage),
          [0],
        );
        yield* TestClock.adjust("1 millis");
        assert.deepStrictEqual(
          (yield* events).map((event) => event.percentage),
          [0, 75],
        );
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          (yield* events).map((event) => event.percentage),
          [0, 75, 100],
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("uploads with the configured token", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        const result = yield* store.put(pathname("foo.txt"), "Test Body", { access: "public" });
        assertPutResult(result, mockedFileMetaPut);
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "PUT");
        assert.strictEqual(request.url, "/api/blob/?pathname=foo.txt");
        assert.strictEqual(request.headers.authorization, "Bearer vercel_blob_rw_newStore_secret");
        assert.strictEqual(request.headers["x-vercel-blob-store-id"], "newStore");
        assert.strictEqual(request.text, "Test Body");
      }).pipe(Effect.provide(storeLayer({ token: "vercel_blob_rw_newStore_secret" }))),
    );

    it.effect("sends a custom content type", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        yield* store.put(pathname("foo.txt"), "Test Body", {
          access: "public",
          contentType: "text/plain",
        });
        assert.strictEqual((yield* lastRequest).headers["x-content-type"], "text/plain");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with ApiForbidden for an invalid token", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(403, { code: "forbidden" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(
          store.put(pathname("foo.txt"), "Test Body", {
            access: "public",
            contentType: "text/plain",
          }),
        );
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(
          failure.reason.message,
          "Access denied, please provide a valid token for this resource.",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with a generic error when the API returns a 500", () =>
      Effect.gen(function* () {
        yield* enqueue({ status: 500, body: "Generic Error" });
        const store = yield* BlobStore;
        const error = yield* Effect.flip(
          store.put(pathname("foo.txt"), "Test Body", {
            access: "public",
            contentType: "text/plain",
          }),
        );
        const failure = expectTagged(error, "VercelApiError");
        assert.strictEqual(
          failure.reason.message,
          "Unknown error, please visit https://vercel.com/help.",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("uploads an empty string body (the SDK refuses it as missing)", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        yield* store.put(pathname("path.txt"), "", { access: "public" });
        assert.strictEqual((yield* lastRequest).text, "");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("uploads with private access", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        const result = yield* store.put(pathname("foo.txt"), "Test Body", { access: "private" });
        assertPutResult(result, mockedFileMetaPut);
        const request = yield* lastRequest;
        assert.strictEqual(request.url, "/api/blob/?pathname=foo.txt");
        assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
        assert.strictEqual(request.headers["x-vercel-blob-access"], "private");
        assert.strictEqual(request.text, "Test Body");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sets x-vercel-blob-access for public access", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        yield* store.put(pathname("foo.txt"), "Test Body", { access: "public" });
        assert.strictEqual((yield* lastRequest).headers["x-vercel-blob-access"], "public");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sets x-add-random-suffix", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        yield* store.put(pathname("foo.txt"), "Test Body", {
          access: "public",
          addRandomSuffix: false,
        });
        assert.strictEqual((yield* lastRequest).headers["x-add-random-suffix"], "0");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sets x-cache-control-max-age in seconds", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        yield* store.put(pathname("foo.txt"), "Test Body", {
          access: "public",
          cacheControlMaxAge: "60 seconds",
        });
        assert.strictEqual((yield* lastRequest).headers["x-cache-control-max-age"], "60");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sends bytes, Blobs and streams as the body", () =>
      Effect.gen(function* () {
        yield* enqueue(
          json(200, mockedFileMetaPut),
          json(200, mockedFileMetaPut),
          json(200, mockedFileMetaPut),
        );
        const store = yield* BlobStore;
        const encoder = new TextEncoder();
        yield* store.put(pathname("a.txt"), encoder.encode("bytes"), { access: "public" });
        yield* store.put(pathname("b.txt"), new Blob(["blob"]), { access: "public" });
        yield* store.put(
          pathname("c.txt"),
          Stream.fromIterable([encoder.encode("str"), encoder.encode("eam")]),
          { access: "public" },
        );
        assert.deepStrictEqual(
          (yield* requests).map((request) => request.text),
          ["bytes", "blob", "stream"],
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with BlobUploadRejected when the store refuses the content type", () =>
      Effect.gen(function* () {
        yield* enqueue(
          errorBody(400, {
            code: "bad_request",
            message: "contentType text/html is not allowed",
          }),
        );
        const store = yield* BlobStore;
        const error = yield* Effect.flip(
          store.put(pathname("foo.txt"), "Test Body", { access: "public" }),
        );
        assert.strictEqual(error._tag, "BlobUploadRejected");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("routes multipart operations to /mpu with the server write headers", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* enqueue(
          json(200, { uploadId: "upload-1", key: "key/1" }),
          json(200, { etag: "etag1" }),
          json(200, mockedFileMetaPut),
        );
        const result = yield* store.put(pathname("big.bin"), "data", {
          access: "private",
          multipart: true,
          addRandomSuffix: true,
          cacheControlMaxAge: "60 seconds",
        });
        assert.strictEqual(result.pathname, mockedFileMetaPut.pathname);
        const sent = yield* requests;
        assert.deepStrictEqual(
          sent.map((request) => [request.method, request.url, request.headers["x-mpu-action"]]),
          [
            ["POST", "/api/blob/mpu?pathname=big.bin", "create"],
            ["POST", "/api/blob/mpu?pathname=big.bin", "upload"],
            ["POST", "/api/blob/mpu?pathname=big.bin", "complete"],
          ],
        );
        for (const request of sent) {
          assert.strictEqual(request.headers["authorization"], `Bearer ${token}`);
          assert.strictEqual(request.headers["x-vercel-blob-access"], "private");
          assert.strictEqual(request.headers["x-add-random-suffix"], "1");
          assert.strictEqual(request.headers["x-cache-control-max-age"], "60");
        }
        assert.strictEqual(sent[1]?.text, "data");
        assert.strictEqual(sent[2]?.text, '[{"partNumber":1,"etag":"etag1"}]');
        assert.strictEqual(sent[1]?.headers["content-type"], "application/octet-stream");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("exposes the manual multipart primitives", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* enqueue(
          json(200, { uploadId: "upload-1", key: "key/1" }),
          json(200, { etag: "etag1" }),
          json(200, mockedFileMetaPut),
        );
        const upload = yield* store.createMultipartUpload(pathname("big.bin"), {
          access: "public",
        });
        assert.strictEqual(upload.uploadId, "upload-1");
        assert.strictEqual(upload.key, "key/1");
        const part = yield* store.uploadPart(upload, PartNumber.make(1), "data");
        assert.deepStrictEqual([part.etag, part.partNumber], ["etag1", 1]);
        yield* store.completeMultipartUpload(upload, [part]);
        const sent = yield* requests;
        assert.strictEqual(sent[1]?.headers["x-mpu-key"], encodeURIComponent("key/1"));
        assert.strictEqual(sent[1]?.headers["x-mpu-upload-id"], "upload-1");
        assert.strictEqual(sent[1]?.headers["x-mpu-part-number"], "1");
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("pathname validation", () => {
    const decode = Schema.decodeUnknownOption(BlobPathname);

    it("accepts pathnames up to 950 characters", () => {
      assert.strictEqual(maximumPathnameLength, 950);
      assert.isTrue(Option.isSome(decode("a".repeat(950))));
      assert.isTrue(Option.isSome(decode("foo/bar.txt")));
    });

    it("rejects pathnames that are too long", () => {
      assert.isTrue(Option.isNone(decode("a".repeat(951))));
    });

    it("rejects pathnames that contain //", () => {
      assert.isTrue(Option.isNone(decode("foo//bar.txt")));
    });

    it("rejects an empty pathname", () => {
      assert.isTrue(Option.isNone(decode("")));
    });
  });

  describe("type-level rejections", () => {
    it("rejects input the SDK refuses at runtime", () => {
      // Never invoked: these calls only pin compile-time errors for cases the SDK tests at runtime.
      const rejected = (store: BlobStore["Service"], upload: MultipartUpload) => [
        // @ts-expect-error: access must be "public" or "private"
        store.put(pathname("foo.txt"), "Test Body", { access: "invalid" }),
        // @ts-expect-error: a plain object is not a body
        store.put(pathname("foo.txt"), { file: "value" }, { access: "public" }),
        store.put(
          pathname("foo.txt"),
          // @ts-expect-error: a plain object is not a body, multipart or not
          { file: "value" },
          { access: "public", multipart: true },
        ),
        // @ts-expect-error: a plain object is not a body
        store.uploadPart(upload, PartNumber.make(1), { file: "value" }),
        // @ts-expect-error: ifMatch implies overwriting, so allowOverwrite cannot be false
        store.put(pathname("foo.txt"), "Test Body", {
          access: "public",
          ifMatch: etag('"abc123"'),
          allowOverwrite: false,
        }),
        // @ts-expect-error: ifMatch is only accepted when deleting one blob
        store.delMany([`${BLOB_STORE_BASE_URL}/a.txt`, `${BLOB_STORE_BASE_URL}/b.txt`], {
          ifMatch: etag('"abc123"'),
        }),
        // @ts-expect-error: access must be "public" or "private"
        store.copy("source", pathname("destination.txt"), { access: "invalid" }),
        // @ts-expect-error: access must be "public" or "private"
        store.rename("source", pathname("destination.txt"), { access: "invalid" }),
        // @ts-expect-error: options are required
        store.get("foo.txt"),
        // @ts-expect-error: access must be "public" or "private"
        store.get("foo.txt", { access: "invalid" }),
        // @ts-expect-error: a destination must be a validated pathname
        store.copy("source", "a".repeat(951), { access: "public" }),
      ];
      assert.isFunction(rejected);
    });
  });

  describe("copy", () => {
    it.effect("copies a blob with private access", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCopyResult));
        const store = yield* BlobStore;
        const result = yield* store.copy("source.txt", pathname("destination.txt"), {
          access: "private",
        });
        assertPutResult(result, mockedCopyResult);
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "PUT");
        assert.strictEqual(request.url, "/api/blob?pathname=destination.txt&fromUrl=source.txt");
        assert.strictEqual(request.headers["x-vercel-blob-access"], "private");
        assert.strictEqual(request.text, "");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sets x-vercel-blob-access for public access", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCopyResult));
        const store = yield* BlobStore;
        yield* store.copy("source.txt", pathname("destination.txt"), { access: "public" });
        assert.strictEqual((yield* lastRequest).headers["x-vercel-blob-access"], "public");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("returns the etag", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, { ...mockedCopyResult, etag: '"copyetag"' }));
        const store = yield* BlobStore;
        const result = yield* store.copy("source.txt", pathname("destination.txt"), {
          access: "public",
        });
        assert.strictEqual(result.etag, '"copyetag"');
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sends x-if-match without implying x-allow-overwrite", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCopyResult));
        const store = yield* BlobStore;
        yield* store.copy("source.txt", pathname("destination.txt"), {
          access: "public",
          ifMatch: etag('"source-etag"'),
        });
        const request = yield* lastRequest;
        assert.strictEqual(request.headers["x-if-match"], '"source-etag"');
        assert.notProperty(request.headers, "x-allow-overwrite");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sends every write option", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCopyResult));
        const store = yield* BlobStore;
        yield* store.copy(new URL(`${BLOB_STORE_BASE_URL}/source.txt`), pathname("dest.txt"), {
          access: "public",
          addRandomSuffix: true,
          allowOverwrite: true,
          contentType: "text/csv",
          cacheControlMaxAge: "2 minutes",
        });
        const request = yield* lastRequest;
        assert.strictEqual(
          request.url,
          "/api/blob?pathname=dest.txt&fromUrl=https%3A%2F%2Fstoreid.public.blob.vercel-storage.com%2Fsource.txt",
        );
        assert.strictEqual(request.headers["x-add-random-suffix"], "1");
        assert.strictEqual(request.headers["x-allow-overwrite"], "1");
        assert.strictEqual(request.headers["x-content-type"], "text/csv");
        assert.strictEqual(request.headers["x-cache-control-max-age"], "120");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with BlobNotFound when the source does not exist", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(404, { code: "not_found" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(
          store.copy("source.txt", pathname("destination.txt"), { access: "public" }),
        );
        assert.strictEqual(error._tag, "BlobNotFound");
        assert.deepInclude(error, { locator: "source.txt" });
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("rename", () => {
    it.effect("renames a blob with a POST to /rename", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCopyResult));
        const store = yield* BlobStore;
        const result = yield* store.rename("source.txt", pathname("destination.txt"), {
          access: "public",
        });
        assertPutResult(result, mockedCopyResult);
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(
          request.url,
          "/api/blob/rename?pathname=destination.txt&fromUrl=source.txt",
        );
        assert.strictEqual(request.headers["x-vercel-blob-access"], "public");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sets x-vercel-blob-access for private access", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCopyResult));
        const store = yield* BlobStore;
        yield* store.rename("source.txt", pathname("destination.txt"), { access: "private" });
        assert.strictEqual((yield* lastRequest).headers["x-vercel-blob-access"], "private");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sets x-allow-overwrite and x-add-random-suffix", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCopyResult));
        const store = yield* BlobStore;
        yield* store.rename("source.txt", pathname("destination.txt"), {
          access: "public",
          allowOverwrite: true,
          addRandomSuffix: true,
        });
        const request = yield* lastRequest;
        assert.strictEqual(request.headers["x-allow-overwrite"], "1");
        assert.strictEqual(request.headers["x-add-random-suffix"], "1");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sends x-if-match", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedCopyResult));
        const store = yield* BlobStore;
        yield* store.rename("source.txt", pathname("destination.txt"), {
          access: "public",
          ifMatch: etag('"source-etag"'),
        });
        assert.strictEqual((yield* lastRequest).headers["x-if-match"], '"source-etag"');
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with BlobPreconditionFailed when the source changed", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(412, { code: "precondition_failed" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(
          store.rename("source.txt", pathname("destination.txt"), {
            access: "public",
            ifMatch: etag('"old"'),
          }),
        );
        assert.strictEqual(error._tag, "BlobPreconditionFailed");
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("createFolder", () => {
    it.effect("appends a trailing slash and defaults to public access", () =>
      Effect.gen(function* () {
        yield* enqueue(
          json(200, {
            ...mockedFileMetaPut,
            url: `${BLOB_STORE_BASE_URL}/docs/`,
            pathname: "docs/",
          }),
        );
        const store = yield* BlobStore;
        const result = yield* store.createFolder(pathname("docs"));
        assert.strictEqual(result.url.href, "https://storeid.public.blob.vercel-storage.com/docs/");
        assert.strictEqual(result.pathname, "docs/");
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "PUT");
        assert.strictEqual(request.url, "/api/blob/?pathname=docs%2F");
        assert.strictEqual(request.headers["x-vercel-blob-access"], "public");
        assert.strictEqual(request.headers["x-add-random-suffix"], "0");
        assert.strictEqual(request.text, "");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("keeps an existing trailing slash and sends the access", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, { url: `${BLOB_STORE_BASE_URL}/docs/`, pathname: "docs/" }));
        const store = yield* BlobStore;
        yield* store.createFolder(pathname("docs/"), { access: "private" });
        const request = yield* lastRequest;
        assert.strictEqual(request.url, "/api/blob/?pathname=docs%2F");
        assert.strictEqual(request.headers["x-vercel-blob-access"], "private");
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("get", () => {
    const storeHost = "12345fakestoreid";

    it.effect("dies without a url or pathname", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const exit = yield* Effect.exit(store.get("", { access: "public" }));
        assert.strictEqual(defectMessage(exit), "Vercel Blob: url or pathname is required");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reads a public blob by pathname from the store's host", () =>
      Effect.gen(function* () {
        yield* enqueue(blobResponse("blob content"));
        const store = yield* BlobStore;
        const result = found(yield* store.get("test-file.txt", { access: "public" }));
        assert.strictEqual(
          result.blob.url.href,
          `https://${storeHost}.public.blob.vercel-storage.com/test-file.txt`,
        );
        assert.strictEqual(result.blob.pathname, "test-file.txt");
        assert.strictEqual(result.contentType, "text/plain");
        assert.strictEqual(result.size, 12);
        assert.strictEqual(yield* Stream.mkString(Stream.decodeText(result.body)), "blob content");
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "GET");
        assert.strictEqual(
          request.url,
          `/__blob/${storeHost}.public.blob.vercel-storage.com/test-file.txt`,
        );
        assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
        assert.notProperty(request.headers, "if-none-match");
        assert.notProperty(request.headers, "x-api-version");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reads a private blob by pathname from the store's private host", () =>
      Effect.gen(function* () {
        yield* enqueue(blobResponse("blob content"));
        const store = yield* BlobStore;
        const result = found(yield* store.get("test-file.txt", { access: "private" }));
        assert.strictEqual(
          result.blob.url.href,
          `https://${storeHost}.private.blob.vercel-storage.com/test-file.txt`,
        );
        assert.strictEqual(result.blob.pathname, "test-file.txt");
        assert.strictEqual(
          (yield* lastRequest).url,
          `/__blob/${storeHost}.private.blob.vercel-storage.com/test-file.txt`,
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reads pathnames under the configured blob base URL", () =>
      Effect.gen(function* () {
        yield* enqueue(blobResponse("emulated"));
        const store = yield* BlobStore;
        const server = yield* TestHttpServer;
        const result = found(yield* store.get("dir/a.txt", { access: "private" }));
        assert.strictEqual(
          result.blob.url.href,
          `${server.url}/stores/12345fakeStoreId/private/dir/a.txt`,
        );
        assert.strictEqual((yield* lastRequest).url, "/stores/12345fakeStoreId/private/dir/a.txt");
      }).pipe(
        Effect.provide(
          storeLayer({
            blobBaseUrl: (serverUrl) => (storeId, access) =>
              new URL(`${serverUrl}/stores/${storeId}/${access}`),
          }),
        ),
      ),
    );

    for (const access of ["private", "public"] as const) {
      it.effect(`dies when the URL points to an external domain (${access})`, () =>
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const exit = yield* Effect.exit(store.get("https://evil.com/xss.html", { access }));
          assert.strictEqual(
            defectMessage(exit),
            "Vercel Blob: Invalid URL: the URL does not point to a Vercel Blob store. Use a pathname instead, see https://vercel.com/docs/vercel-blob",
          );
          assert.strictEqual((yield* requests).length, 0);
        }).pipe(Effect.provide(TestLayer)),
      );
    }

    it.effect("dies when the URL uses subdomain spoofing", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const exit = yield* Effect.exit(
          store.get(new URL("https://blob.vercel-storage.com.evil.com/f.txt"), {
            access: "private",
          }),
        );
        assert.include(defectMessage(exit), "does not point to a Vercel Blob store");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("dies when a URL-looking string does not parse", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const exit = yield* Effect.exit(store.get("https://", { access: "public" }));
        assert.strictEqual(
          defectMessage(exit),
          "Vercel Blob: Invalid URL: unable to parse the provided URL",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("allows a URL on the overridden API URL's origin (local emulator)", () =>
      Effect.gen(function* () {
        yield* enqueue(blobResponse("emulated content"));
        const store = yield* BlobStore;
        const server = yield* TestHttpServer;
        const url = `${server.url}/vercel/blob/store_123/foo.txt`;
        const result = found(yield* store.get(url, { access: "public" }));
        assert.strictEqual(result.blob.url.href, url);
        // The pathname comes from the URL, so it keeps the emulator's route prefix.
        assert.strictEqual(result.blob.pathname, "vercel/blob/store_123/foo.txt");
        assert.strictEqual((yield* lastRequest).url, "/vercel/blob/store_123/foo.txt");
      }).pipe(Effect.provide(storeLayer({ apiUrl: (serverUrl) => `${serverUrl}/vercel/blob` }))),
    );

    it.effect("dies when the URL origin differs from the overridden API URL's origin", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const exit = yield* Effect.exit(
          store.get("http://localhost:4000/foo.txt", { access: "public" }),
        );
        assert.include(defectMessage(exit), "does not point to a Vercel Blob store");
      }).pipe(Effect.provide(storeLayer({ apiUrl: () => "http://localhost:3001/vercel/blob" }))),
    );

    it.effect("dies for a localhost URL when the API URL is the default", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const exit = yield* Effect.exit(
          store.get("http://localhost:3001/foo.txt", { access: "public" }),
        );
        assert.include(defectMessage(exit), "does not point to a Vercel Blob store");
      }).pipe(Effect.provide(storeLayer({ apiUrl: () => "https://vercel.com/api/blob" }))),
    );

    it.effect("reads a valid blob store URL", () =>
      Effect.gen(function* () {
        yield* enqueue(blobResponse("blob content"));
        const store = yield* BlobStore;
        const result = found(
          yield* store.get("https://storeId.public.blob.vercel-storage.com/file.txt", {
            access: "public",
          }),
        );
        assert.strictEqual(result.blob.pathname, "file.txt");
        assert.strictEqual(
          (yield* lastRequest).url,
          "/__blob/storeid.public.blob.vercel-storage.com/file.txt",
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    describe("useCache", () => {
      const cases: ReadonlyArray<readonly [string, BlobAccess, boolean | undefined, string]> = [
        ["appends cache=0 when useCache is false", "private", false, "/foo.txt?cache=0"],
        ["does not append cache=0 when useCache is true", "private", true, "/foo.txt"],
        ["does not append cache=0 when useCache is omitted", "private", undefined, "/foo.txt"],
        [
          "does not append cache=0 when useCache is false with public access",
          "public",
          false,
          "/foo.txt",
        ],
      ];
      for (const [name, access, useCache, path] of cases) {
        it.effect(name, () =>
          Effect.gen(function* () {
            yield* enqueue(blobResponse("blob content"));
            const store = yield* BlobStore;
            const result = found(yield* store.get("foo.txt", { access, useCache }));
            assert.strictEqual(result.blob.pathname, "foo.txt");
            assert.strictEqual(
              (yield* lastRequest).url,
              `/__blob/${storeHost}.${access}.blob.vercel-storage.com${path}`,
            );
          }).pipe(Effect.provide(TestLayer)),
        );
      }

      it.effect("does not include cache=0 in the returned url or downloadUrl", () =>
        Effect.gen(function* () {
          yield* enqueue(blobResponse("blob content"));
          const store = yield* BlobStore;
          const result = found(yield* store.get("foo.txt", { access: "private", useCache: false }));
          assert.strictEqual(
            result.blob.downloadUrl.href,
            `https://${storeHost}.private.blob.vercel-storage.com/foo.txt?download=1`,
          );
          assert.strictEqual(
            result.blob.url.href,
            `https://${storeHost}.private.blob.vercel-storage.com/foo.txt`,
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("works with a URL and useCache false", () =>
        Effect.gen(function* () {
          yield* enqueue(blobResponse("blob content"));
          const store = yield* BlobStore;
          found(
            yield* store.get("https://storeId.private.blob.vercel-storage.com/foo.txt", {
              access: "private",
              useCache: false,
            }),
          );
          assert.strictEqual(
            (yield* lastRequest).url,
            "/__blob/storeid.private.blob.vercel-storage.com/foo.txt?cache=0",
          );
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    describe("conditional requests", () => {
      it.effect("returns NotModified on a 304", () =>
        Effect.gen(function* () {
          yield* enqueue({
            status: 304,
            headers: {
              etag: '"abc123"',
              "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
              "cache-control": "public, max-age=31536000",
              "content-disposition": 'attachment; filename="foo.txt"',
            },
          });
          const store = yield* BlobStore;
          const result = notModified(
            yield* store.get("foo.txt", { access: "private", ifNoneMatch: '"abc123"' }),
          );
          assert.notProperty(result, "body");
          assert.strictEqual(result.blob.etag, '"abc123"');
          assert.strictEqual(result.blob.cacheControl, "public, max-age=31536000");
          assert.strictEqual(result.blob.contentDisposition, 'attachment; filename="foo.txt"');
          assert.strictEqual(result.blob.pathname, "foo.txt");
          assert.strictEqual(
            DateTime.formatIso(result.blob.uploadedAt),
            "2025-01-01T00:00:00.000Z",
          );
          assert.strictEqual(result.headers.etag, '"abc123"');
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("sends If-None-Match when ifNoneMatch is set", () =>
        Effect.gen(function* () {
          yield* enqueue({
            status: 304,
            headers: { etag: '"etag-value"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" },
          });
          const store = yield* BlobStore;
          notModified(
            yield* store.get("foo.txt", { access: "private", ifNoneMatch: '"etag-value"' }),
          );
          assert.strictEqual((yield* lastRequest).headers["if-none-match"], '"etag-value"');
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("returns Found with the body on a normal response", () =>
        Effect.gen(function* () {
          yield* enqueue(blobResponse("blob content", { etag: '"abc123"' }));
          const store = yield* BlobStore;
          const result = found(yield* store.get("foo.txt", { access: "private" }));
          assert.strictEqual(result.contentType, "text/plain");
          assert.strictEqual(result.size, 12);
          assert.strictEqual(result.blob.etag, '"abc123"');
          assert.strictEqual(
            yield* Stream.mkString(Stream.decodeText(result.body)),
            "blob content",
          );
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    it.effect("reads metadata from the response headers, with defaults", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 2, 3, 4, 5));
        yield* enqueue({ status: 200, body: "x" });
        const store = yield* BlobStore;
        const result = found(yield* store.get("foo.txt", { access: "public" }));
        // The test server sends this body chunked, without Content-Length.
        assert.notProperty(result.headers, "content-length");
        assert.strictEqual(result.contentType, "application/octet-stream");
        assert.strictEqual(result.size, 0);
        assert.strictEqual(result.blob.contentDisposition, "");
        assert.strictEqual(result.blob.cacheControl, "");
        assert.strictEqual(result.blob.etag, "");
        assert.strictEqual(DateTime.formatIso(result.blob.uploadedAt), "2026-01-02T03:04:05.000Z");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("lets the headers option override the defaults", () =>
      Effect.gen(function* () {
        yield* enqueue(blobResponse("x"));
        const store = yield* BlobStore;
        found(
          yield* store.get("foo.txt", {
            access: "public",
            ifNoneMatch: '"a"',
            headers: { authorization: "Bearer other", "if-none-match": '"b"', "x-extra": "1" },
          }),
        );
        const request = yield* lastRequest;
        assert.strictEqual(request.headers.authorization, "Bearer other");
        assert.strictEqual(request.headers["if-none-match"], '"b"');
        assert.strictEqual(request.headers["x-extra"], "1");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with BlobNotFound on a 404", () =>
      Effect.gen(function* () {
        yield* enqueue({ status: 404, body: "Not Found" });
        const store = yield* BlobStore;
        const error = yield* Effect.flip(store.get("missing.txt", { access: "public" }));
        assert.strictEqual(error._tag, "BlobNotFound");
        assert.deepInclude(error, { locator: "missing.txt" });
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with VercelApiError built from the status otherwise", () =>
      Effect.gen(function* () {
        yield* enqueue({ status: 500, body: "boom" }, { status: 403, body: "denied" });
        const store = yield* BlobStore;
        const server = yield* Effect.flip(store.get("foo.txt", { access: "public" }));
        const forbidden = yield* Effect.flip(store.get("foo.txt", { access: "public" }));
        const serverFailure = expectTagged(server, "VercelApiError");
        assert.strictEqual(serverFailure.operation, "BlobStore.get");
        assert.deepStrictEqual(serverFailure.errorCode, Option.none());
        assert.strictEqual(serverFailure.reason._tag, "ApiServerError");
        assert.strictEqual(serverFailure.reason.message, "Failed to fetch blob: 500");
        const forbiddenFailure = expectTagged(forbidden, "VercelApiError");
        assert.strictEqual(forbiddenFailure.reason._tag, "ApiForbidden");
        // No retries for blob reads.
        assert.strictEqual((yield* requests).length, 2);
      }).pipe(Effect.provide(storeLayer({ retries: 3 }))),
    );

    it.effect("reports body read failures as ApiNetworkFailure", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const result = found(yield* store.get("foo.txt", { access: "public" }));
        const error = yield* Effect.flip(Stream.runDrain(result.body));
        assert.strictEqual(error.operation, "BlobStore.get");
        assert.strictEqual(error.reason._tag, "ApiNetworkFailure");
      }).pipe(
        Effect.provide(
          storeLayer({
            httpClient: Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      new ReadableStream({
                        pull: (controller) => controller.error(new Error("connection reset")),
                      }),
                      { status: 200 },
                    ),
                  ),
                ),
              ),
            ),
          }),
        ),
      ),
    );

    it.effect("uses the OIDC token and its store id", () =>
      Effect.gen(function* () {
        yield* enqueue(blobResponse("x"));
        const store = yield* BlobStore;
        found(yield* store.get("foo.txt", { access: "private" }));
        const request = yield* lastRequest;
        assert.strictEqual(
          request.url,
          "/__blob/customstore.private.blob.vercel-storage.com/foo.txt",
        );
        assert.strictEqual(request.headers.authorization, "Bearer oidc-from-option");
      }).pipe(
        Effect.provide(storeLayer({ storeId: "customStore", oidcToken: "oidc-from-option" })),
      ),
    );
  });

  describe("etag support", () => {
    it.effect("put returns the etag", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        const result = yield* store.put(pathname("foo.txt"), "Test Body", { access: "public" });
        assert.strictEqual(result.etag, '"abc123"');
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("put sends x-if-match and implies x-allow-overwrite", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        yield* store.put(pathname("foo.txt"), "Test Body", {
          access: "public",
          ifMatch: etag('"abc123"'),
        });
        const request = yield* lastRequest;
        assert.strictEqual(request.headers["x-if-match"], '"abc123"');
        assert.strictEqual(request.headers["x-allow-overwrite"], "1");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("put accepts ifMatch with allowOverwrite: true", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        yield* store.put(pathname("foo.txt"), "Test Body", {
          access: "public",
          ifMatch: etag('"abc123"'),
          allowOverwrite: true,
        });
        const request = yield* lastRequest;
        assert.strictEqual(request.headers["x-if-match"], '"abc123"');
        assert.strictEqual(request.headers["x-allow-overwrite"], "1");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("head returns the etag", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMeta));
        const store = yield* BlobStore;
        const result = yield* store.head(`${BLOB_STORE_BASE_URL}/foo-id.txt`);
        assert.strictEqual(result.etag, '"abc123"');
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("put fails with BlobPreconditionFailed on a 412", () =>
      Effect.gen(function* () {
        yield* enqueue(errorBody(412, { code: "precondition_failed" }));
        const store = yield* BlobStore;
        const error = yield* Effect.flip(
          store.put(pathname("foo.txt"), "Test Body", {
            access: "public",
            ifMatch: etag('"old-etag"'),
          }),
        );
        assert.strictEqual(error._tag, "BlobPreconditionFailed");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("sends the current x-api-version", () =>
      Effect.gen(function* () {
        yield* enqueue(json(200, mockedFileMetaPut));
        const store = yield* BlobStore;
        yield* store.put(pathname("foo.txt"), "Test Body", { access: "public" });
        assert.strictEqual((yield* lastRequest).headers["x-api-version"], "13");
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("putImage", () => {
    const optimize = (
      width: number,
      quality?: number,
      format?: ImageFormat,
    ): {
      readonly width: ImageWidth;
      readonly quality?: ImageQuality;
      readonly format?: ImageFormat;
    } => ({
      width: ImageWidth.make(width),
      ...(quality === undefined ? {} : { quality: ImageQuality.make(quality) }),
      ...(format === undefined ? {} : { format }),
    });

    describe("body source", () => {
      it.effect("sends a POST to /put-optimized with the optimize params and body", () =>
        Effect.gen(function* () {
          yield* enqueue(json(200, mockedOptimizedBlob));
          const store = yield* BlobStore;
          const result = yield* store.putImage(pathname("avatar.webp"), "image-bytes", {
            access: "public",
            optimizeImage: optimize(128, 80, "webp"),
          });
          assertPutResult(result, mockedOptimizedBlob);
          const request = yield* lastRequest;
          assert.strictEqual(request.method, "POST");
          assert.strictEqual(
            request.url,
            "/api/blob/put-optimized?pathname=avatar.webp&width=128&quality=80&format=image%2Fwebp",
          );
          assert.strictEqual(request.headers["x-vercel-blob-access"], "public");
          assert.strictEqual(request.text, "image-bytes");
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("treats any string as body content, even one that looks like a URL", () =>
        Effect.gen(function* () {
          yield* enqueue(json(200, mockedOptimizedBlob));
          const store = yield* BlobStore;
          yield* store.putImage(pathname("avatar.webp"), "https://example.com/image.jpg", {
            access: "public",
            optimizeImage: optimize(128),
          });
          const request = yield* lastRequest;
          // Also the SDK's "defaults quality to 75 and omits format" case.
          assert.strictEqual(
            request.url,
            "/api/blob/put-optimized?pathname=avatar.webp&width=128&quality=75",
          );
          assert.strictEqual(request.text, "https://example.com/image.jpg");
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("forwards addRandomSuffix and cacheControlMaxAge", () =>
        Effect.gen(function* () {
          yield* enqueue(json(200, mockedOptimizedBlob));
          const store = yield* BlobStore;
          yield* store.putImage(pathname("avatar.webp"), "image-bytes", {
            access: "public",
            addRandomSuffix: true,
            cacheControlMaxAge: "60 seconds",
            optimizeImage: optimize(128),
          });
          const request = yield* lastRequest;
          assert.strictEqual(request.headers["x-add-random-suffix"], "1");
          assert.strictEqual(request.headers["x-cache-control-max-age"], "60");
          assert.notProperty(request.headers, "x-content-type");
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("fails before any request when a Blob body declares a non-image type", () =>
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const error = yield* Effect.flip(
            store.putImage(
              pathname("avatar.webp"),
              new Blob(["<html></html>"], { type: "text/html" }),
              { access: "public", optimizeImage: optimize(128) },
            ),
          );
          const failure = expectTagged(error, "BlobUploadRejected");
          assert.strictEqual(failure.reason._tag, "ContentTypeNotAllowed");
          assert.deepInclude(failure.reason, {
            message: 'optimizeImage requires an image body, but the content type is "text/html"',
          });
          assert.strictEqual((yield* requests).length, 0);
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("accepts Blob bodies with an image, octet-stream or unknown type", () =>
        Effect.gen(function* () {
          yield* enqueue(
            json(200, mockedOptimizedBlob),
            json(200, mockedOptimizedBlob),
            json(200, mockedOptimizedBlob),
          );
          const store = yield* BlobStore;
          for (const type of ["image/png", "application/octet-stream", ""]) {
            const result = yield* store.putImage(
              pathname("avatar.webp"),
              new Blob(["bytes"], { type }),
              { access: "public", optimizeImage: optimize(128) },
            );
            assertPutResult(result, mockedOptimizedBlob);
          }
          assert.deepStrictEqual(
            (yield* requests).map((request) => request.text),
            ["bytes", "bytes", "bytes"],
          );
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("leaves bodies without a media type to the server", () =>
        Effect.gen(function* () {
          yield* enqueue(json(200, mockedOptimizedBlob));
          const store = yield* BlobStore;
          const result = yield* store.putImage(pathname("avatar.webp"), "maybe-image-bytes", {
            access: "public",
            optimizeImage: optimize(128),
          });
          assertPutResult(result, mockedOptimizedBlob);
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("reports upload progress", () =>
        Effect.gen(function* () {
          yield* enqueue(json(200, mockedOptimizedBlob));
          const store = yield* BlobStore;
          const events = yield* Ref.make<ReadonlyArray<number>>([]);
          yield* store.putImage(pathname("avatar.webp"), "image-bytes", {
            access: "public",
            optimizeImage: optimize(128),
            onUploadProgress: (progress) =>
              Ref.update(events, (all) => [...all, progress.percentage]),
          });
          assert.deepStrictEqual(yield* Ref.get(events), [0, 100]);
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    describe("URL source", () => {
      it.effect("sends a POST to /put-from-url when the source is a URL", () =>
        Effect.gen(function* () {
          yield* enqueue(json(200, mockedOptimizedBlob));
          const store = yield* BlobStore;
          const result = yield* store.putImage(
            pathname("avatar.webp"),
            new URL("https://example.com/image.jpg"),
            { access: "public", optimizeImage: optimize(128, 80, "webp") },
          );
          assertPutResult(result, mockedOptimizedBlob);
          const request = yield* lastRequest;
          assert.strictEqual(request.method, "POST");
          assert.strictEqual(
            request.url,
            "/api/blob/put-from-url?pathname=avatar.webp&url=https%3A%2F%2Fexample.com%2Fimage.jpg&width=128&quality=80&format=image%2Fwebp",
          );
          assert.strictEqual(request.headers["x-vercel-blob-access"], "public");
          assert.strictEqual(request.text, "");
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("forwards addRandomSuffix, allowOverwrite and cacheControlMaxAge", () =>
        Effect.gen(function* () {
          yield* enqueue(json(200, mockedOptimizedBlob));
          const store = yield* BlobStore;
          yield* store.putImage(pathname("avatar.webp"), new URL("https://example.com/photo.jpg"), {
            access: "public",
            addRandomSuffix: true,
            allowOverwrite: true,
            cacheControlMaxAge: "60 seconds",
            optimizeImage: optimize(128),
          });
          const request = yield* lastRequest;
          assert.strictEqual(request.headers["x-add-random-suffix"], "1");
          assert.strictEqual(request.headers["x-allow-overwrite"], "1");
          assert.strictEqual(request.headers["x-cache-control-max-age"], "60");
        }).pipe(Effect.provide(TestLayer)),
      );

      it.effect("sends x-if-match and implies x-allow-overwrite", () =>
        Effect.gen(function* () {
          yield* enqueue(json(200, mockedOptimizedBlob));
          const store = yield* BlobStore;
          yield* store.putImage(pathname("avatar.webp"), new URL("https://example.com/photo.jpg"), {
            access: "public",
            ifMatch: etag('"abc123"'),
            optimizeImage: optimize(128),
          });
          const request = yield* lastRequest;
          assert.strictEqual(request.headers["x-if-match"], '"abc123"');
          assert.strictEqual(request.headers["x-allow-overwrite"], "1");
        }).pipe(Effect.provide(TestLayer)),
      );

      it("rejects ifMatch with allowOverwrite: false at the type level", () => {
        // @ts-expect-error ifMatch implies overwriting
        const options: PutImageOptions = {
          access: "public",
          ifMatch: etag('"abc123"'),
          allowOverwrite: false,
          optimizeImage: optimize(128),
        };
        assert.isDefined(options);
      });

      it.effect("dies for a non-http(s) URL", () =>
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const exit = yield* Effect.exit(
            store.putImage(pathname("avatar.webp"), new URL("ftp://example.com/image.jpg"), {
              access: "public",
              optimizeImage: optimize(128),
            }),
          );
          assert.strictEqual(
            defectMessage(exit),
            "Vercel Blob: the source URL must use the http(s) protocol",
          );
          assert.strictEqual((yield* requests).length, 0);
        }).pipe(Effect.provide(TestLayer)),
      );
    });

    describe("validation", () => {
      it("rejects contentType and a missing optimizeImage at the type level", () => {
        // Never invoked: these calls only pin compile-time errors.
        const rejected = (store: BlobStore["Service"]) => [
          store.putImage(pathname("avatar.webp"), "image-bytes", {
            access: "public",
            // @ts-expect-error: the optimizer decides the stored media type
            contentType: "image/jpeg",
            optimizeImage: optimize(128),
          }),
          // @ts-expect-error: optimizeImage is required
          store.putImage(pathname("avatar.webp"), "image-bytes", { access: "public" }),
          store.putImage(pathname("avatar.webp"), "image-bytes", {
            access: "public",
            // @ts-expect-error: width must be a validated ImageWidth
            optimizeImage: { width: 128 },
          }),
        ];
        assert.isFunction(rejected);
      });

      it("validates width, quality and format with their schemas", () => {
        const width = Schema.decodeUnknownOption(ImageWidth);
        const quality = Schema.decodeUnknownOption(ImageQuality);
        const format = Schema.decodeUnknownOption(ImageFormat);
        for (const value of [1, 128, 8192]) assert.isTrue(Option.isSome(width(value)));
        for (const value of [undefined, 0, 8193, 128.5]) assert.isTrue(Option.isNone(width(value)));
        for (const value of [1, 75, 100]) assert.isTrue(Option.isSome(quality(value)));
        for (const value of [0, 101, 200, 79.5]) assert.isTrue(Option.isNone(quality(value)));
        for (const value of ["jpeg", "png", "webp", "avif"]) {
          assert.isTrue(Option.isSome(format(value)));
        }
        assert.isTrue(Option.isNone(format("tiff")));
      });
    });
  });

  describe("interruption", () => {
    /*
     * The SDK's abort-signal tests: interrupting an operation while its request is in flight stops
     * it, and no retry follows even though retries are configured.
     */
    const operations: ReadonlyArray<
      readonly [string, (store: BlobStore["Service"]) => Effect.Effect<unknown, unknown>]
    > = [
      ["put", (store) => store.put(pathname("file.txt"), "Hello World!", { access: "public" })],
      [
        "putImage",
        (store) =>
          store.putImage(pathname("a.webp"), "bytes", {
            access: "public",
            optimizeImage: { width: ImageWidth.make(10) },
          }),
      ],
      ["del", (store) => store.del("https://mystore.public.blob.vercel-storage.com/file.txt")],
      ["delMany", (store) => store.delMany(["https://mystore.public.blob.vercel-storage.com/a"])],
      ["list", (store) => store.list()],
      ["listAll", (store) => Stream.runDrain(store.listAll())],
      [
        "copy",
        (store) => store.copy("from.txt", pathname("destination.txt"), { access: "public" }),
      ],
      [
        "rename",
        (store) => store.rename("from.txt", pathname("destination.txt"), { access: "public" }),
      ],
      ["head", (store) => store.head("https://mystore.public.blob.vercel-storage.com/file.txt")],
      ["createFolder", (store) => store.createFolder(pathname("folder"))],
      ["get", (store) => store.get("file.txt", { access: "public" })],
    ];

    for (const [name, operation] of operations) {
      it.effect(`stops the request without retrying: ${name}`, () =>
        Effect.gen(function* () {
          const server = yield* TestHttpServer;
          const gate = yield* Deferred.make<void>();
          yield* server.setHandler(() =>
            Effect.as(Deferred.await(gate), json(200, mockedFileMetaPut)),
          );
          const store = yield* BlobStore;
          const fiber = yield* Effect.forkChild(operation(store));
          while ((yield* server.requests).length === 0) {
            yield* TestClock.withLive(Effect.sleep("5 millis"));
          }
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          assert.isTrue(Exit.hasInterrupts(exit));
          yield* TestClock.adjust("1 hour");
          yield* TestClock.withLive(Effect.sleep("20 millis"));
          assert.strictEqual((yield* server.requests).length, 1);
          yield* Deferred.succeed(gate, undefined);
        }).pipe(Effect.provide(storeLayer({ retries: 10 }))),
      );
    }
  });
});
