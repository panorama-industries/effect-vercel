import type { TestHttpRequest } from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import { TestHttpServer } from "@panorama-industries/effect-vercel-core/testing";
import * as sdk from "@vercel/blob";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, vi } from "vitest";

import type { BlobBody, ETag } from "../../src/contracts/blob-domain.ts";
import type { UploadProgress } from "../../src/contracts/blob-domain.ts";
import type { PutOptions } from "../../src/contracts/blob-store.ts";
import type { Comparison, ErrorMappingRow, Setup } from "./harness.ts";

import { BlobPathname, ETag as ETagSchema, PartNumber } from "../../src/contracts/blob-domain.ts";
import { BlobStore, ImageQuality, ImageWidth } from "../../src/contracts/blob-store.ts";
import { BlobStoreLive } from "../../src/implementation/blob-store-live.ts";
import {
  compare,
  differential,
  errorMapping,
  json,
  oidcFallbackSetup,
  oidcSetup,
  oidcStoreId,
  oidcToken,
  ourFolderResult,
  ourGetResult,
  ourHeadResult,
  ourListResult,
  ourOutcome,
  ourPutResult,
  putResponse,
  readWriteSetup,
  readWriteToken,
  sdkFolderResult,
  sdkGetResult,
  sdkHeadResult,
  sdkListResult,
  sdkOutcome,
  sdkPutResult,
  sortCompletionBody,
  sortParts,
  storeId,
  withoutTag,
  assertSameProgress,
} from "./harness.ts";

const run = (setup: Setup = readWriteSetup) => differential(BlobStoreLive, setup);

const pathname = BlobPathname.make("foo.txt");
const etag = (value: string): ETag => ETagSchema.make(value);

const assertSame = (result: Comparison<unknown>, name = "") => {
  assert.isAbove(result.sdkRequests.length, 0, `${name}: the SDK sent no request`);
  assert.deepStrictEqual(result.ourRequests, result.sdkRequests, `${name}: requests differ`);
  assert.deepStrictEqual(withoutTag(result.ours), result.sdk, `${name}: outcomes differ`);
};

const putOk = json(putResponse());

const headResponse = {
  ...putResponse(),
  size: 12,
  uploadedAt: "2026-03-01T10:00:00.000Z",
  cacheControl: "public, max-age=2592000",
};

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

const streamOf = (chunks: ReadonlyArray<string>) => {
  const encoder = new TextEncoder();
  return {
    sdk: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
    ours: () => Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))),
  };
};

describe("differential: @vercel/blob@2.8.2 vs BlobStoreLive", () => {
  describe("put", () => {
    const putBoth = (
      sdkBody: () => unknown,
      ourBody: () => BlobBody,
      sdkOptions: Record<string, unknown>,
      ourOptions: PutOptions,
      responder: Parameters<typeof compare>[0] = putOk,
    ) =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        return yield* compare(
          responder,
          () =>
            sdkOutcome(
              () =>
                sdk.put(
                  pathname,
                  sdkBody() as string,
                  sdkOptions as unknown as sdk.PutCommandOptions,
                ),
              sdkPutResult,
            ),
          ourOutcome(store.put(pathname, ourBody(), ourOptions), ourPutResult),
        );
      });

    it.live("sends identical requests for every body type", () =>
      Effect.gen(function* () {
        const bytes = new Uint8Array([0, 1, 2, 128, 255, 13, 10]);
        const stream = streamOf(["hello ", "streamed ", "world"]);
        const cases: ReadonlyArray<readonly [string, () => unknown, () => BlobBody]> = [
          ["string", () => "hello world", () => "hello world"],
          ["unicode string", () => "héllo ☃", () => "héllo ☃"],
          ["bytes", () => Buffer.from(bytes), () => bytes],
          [
            "Blob",
            () => new Blob(["blob content"], { type: "text/markdown" }),
            () => new Blob(["blob content"], { type: "text/markdown" }),
          ],
          ["untyped Blob", () => new Blob(["blob content"]), () => new Blob(["blob content"])],
          ["stream", stream.sdk, stream.ours],
        ];
        for (const [name, sdkBody, ourBody] of cases) {
          assertSame(
            yield* putBoth(sdkBody, ourBody, { access: "public" }, { access: "public" }),
            name,
          );
        }
      }).pipe(run()),
    );

    it.live("sends identical headers for every write option combination", () =>
      Effect.gen(function* () {
        for (const access of ["public", "private"] as const) {
          for (const addRandomSuffix of [undefined, true, false]) {
            for (const allowOverwrite of [undefined, true, false]) {
              for (const contentType of [undefined, "text/x-custom"]) {
                for (const cacheControlMaxAge of [undefined, 60, 3600]) {
                  const sdkOptions = {
                    access,
                    ...(addRandomSuffix === undefined ? {} : { addRandomSuffix }),
                    ...(allowOverwrite === undefined ? {} : { allowOverwrite }),
                    ...(contentType === undefined ? {} : { contentType }),
                    ...(cacheControlMaxAge === undefined ? {} : { cacheControlMaxAge }),
                  };
                  const ourOptions = {
                    access,
                    ...(addRandomSuffix === undefined ? {} : { addRandomSuffix }),
                    ...(allowOverwrite === undefined ? {} : { allowOverwrite }),
                    ...(contentType === undefined ? {} : { contentType }),
                    ...(cacheControlMaxAge === undefined
                      ? {}
                      : { cacheControlMaxAge: `${cacheControlMaxAge} seconds` as const }),
                  } as PutOptions;
                  assertSame(
                    yield* putBoth(
                      () => "x",
                      () => "x",
                      sdkOptions,
                      ourOptions,
                    ),
                    JSON.stringify(sdkOptions),
                  );
                }
              }
            }
          }
        }
      }).pipe(run()),
    );

    it.live("sends identical conditional writes (ifMatch)", () =>
      Effect.gen(function* () {
        assertSame(
          yield* putBoth(
            () => "x",
            () => "x",
            { access: "public", ifMatch: '"e1"' },
            { access: "public", ifMatch: etag('"e1"') },
          ),
          "ifMatch implies allowOverwrite",
        );
        assertSame(
          yield* putBoth(
            () => "x",
            () => "x",
            { access: "private", ifMatch: '"e1"', allowOverwrite: true, contentType: "a/b" },
            { access: "private", ifMatch: etag('"e1"'), allowOverwrite: true, contentType: "a/b" },
          ),
          "ifMatch with allowOverwrite",
        );
      }).pipe(run()),
    );

    it.live("sends x-content-length and the proxy header from the environment", () =>
      Effect.gen(function* () {
        const stream = streamOf(["a", "bc"]);
        assertSame(
          yield* putBoth(
            () => "hello",
            () => "hello",
            { access: "public" },
            { access: "public" },
          ),
          "string",
        );
        assertSame(
          yield* putBoth(stream.sdk, stream.ours, { access: "public" }, { access: "public" }),
          "stream",
        );
      }).pipe(
        run({
          auth: "readWrite",
          env: {
            VERCEL_BLOB_USE_X_CONTENT_LENGTH: "1",
            VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API: "1",
          },
        }),
      ),
    );

    it.live("reports the same progress events and x-content-length", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const sdkEvents: Array<UploadProgress> = [];
        const ourEvents: Array<UploadProgress> = [];
        const body = "a".repeat(200 * 1024);
        const result = yield* compare(
          putOk,
          () =>
            sdkOutcome(async () => {
              const value = await sdk.put(pathname, body, {
                access: "public",
                onUploadProgress: (event) => sdkEvents.push({ ...event }),
              });
              await new Promise((resolve) => setTimeout(resolve, 250));
              return value;
            }, sdkPutResult),
          ourOutcome(
            store.put(pathname, body, {
              access: "public",
              onUploadProgress: (event) => Effect.sync(() => ourEvents.push({ ...event })),
            }),
            ourPutResult,
          ).pipe(Effect.tap(() => Effect.sleep("250 millis"))),
        );
        assertSame(result);
        assertSameProgress(ourEvents, sdkEvents);
      }).pipe(run()),
    );
  });

  describe("head", () => {
    it.live("sends identical requests for a pathname and a URL and parses alike", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        for (const locator of [
          "foo.txt",
          "folder/with space/ü.txt",
          putResponse().url,
          `${putResponse().url}?x=1&y=2`,
        ]) {
          assertSame(
            yield* compare(
              json(headResponse),
              () => sdkOutcome(() => sdk.head(locator), sdkHeadResult),
              ourOutcome(store.head(locator), ourHeadResult),
            ),
            locator,
          );
        }
        assertSame(
          yield* compare(
            json(headResponse),
            () => sdkOutcome(() => sdk.head(putResponse().url), sdkHeadResult),
            ourOutcome(store.head(new URL(putResponse().url)), ourHeadResult),
          ),
          "URL object",
        );
      }).pipe(run()),
    );
  });

  describe("list", () => {
    const listBody = {
      blobs: [
        {
          url: putResponse("a.txt").url,
          downloadUrl: putResponse("a.txt").downloadUrl,
          pathname: "a.txt",
          size: 3,
          uploadedAt: "2026-03-01T10:00:00.000Z",
          etag: '"a"',
        },
      ],
      folders: ["dir/"],
      cursor: "next-cursor",
      hasMore: true,
    };

    it.live("sends identical requests for every parameter and parses alike", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const cases: ReadonlyArray<
          readonly [
            Record<string, unknown> | undefined,
            Parameters<BlobStore["Service"]["list"]>[0],
            unknown,
          ]
        > = [
          [
            { limit: 10, prefix: "dir/", cursor: "c1", mode: "folded" },
            { limit: 10, prefix: "dir/", cursor: "c1", mode: "folded" },
            listBody,
          ],
          [{ mode: "folded" }, { mode: "folded" }, { blobs: [], hasMore: false, cursor: null }],
          [
            { mode: "expanded", prefix: "a b/ü" },
            { mode: "expanded", prefix: "a b/ü" },
            { ...listBody, folders: undefined },
          ],
        ];
        for (const [sdkOptions, ourOptions, body] of cases) {
          assertSame(
            yield* compare(
              json(body),
              () =>
                sdkOutcome(
                  () => sdk.list(sdkOptions as Parameters<typeof sdk.list>[0]),
                  sdkListResult,
                ),
              ourOutcome(store.list(ourOptions), ourListResult),
            ),
            JSON.stringify(sdkOptions),
          );
        }
      }).pipe(run()),
    );

    it.live("sends no query string without options", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        for (const [sdkOptions, ourOptions] of [
          [undefined, undefined],
          [{}, {}],
        ] as const) {
          assertSame(
            yield* compare(
              json({ ...listBody, folders: undefined }),
              () => sdkOutcome(() => sdk.list(sdkOptions), sdkListResult),
              ourOutcome(store.list(ourOptions), ourListResult),
            ),
            JSON.stringify(sdkOptions),
          );
        }
      }).pipe(run()),
    );
  });

  describe("del", () => {
    it.live("sends identical requests for del, del with ifMatch and delMany", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const deleted = () => "deleted";
        assertSame(
          yield* compare(
            json({}),
            () => sdkOutcome(() => sdk.del("foo.txt"), deleted),
            ourOutcome(store.del("foo.txt"), deleted),
          ),
          "pathname",
        );
        assertSame(
          yield* compare(
            json({}),
            () => sdkOutcome(() => sdk.del(putResponse().url), deleted),
            ourOutcome(store.del(new URL(putResponse().url)), deleted),
          ),
          "URL",
        );
        assertSame(
          yield* compare(
            json({}),
            () => sdkOutcome(() => sdk.del("foo.txt", { ifMatch: '"e1"' }), deleted),
            ourOutcome(store.del("foo.txt", { ifMatch: etag('"e1"') }), deleted),
          ),
          "ifMatch",
        );
        assertSame(
          yield* compare(
            json({}),
            () => sdkOutcome(() => sdk.del(["a.txt", putResponse("b.txt").url]), deleted),
            ourOutcome(store.delMany(["a.txt", new URL(putResponse("b.txt").url)]), deleted),
          ),
          "delMany",
        );
      }).pipe(run()),
    );
  });

  describe("copy and rename", () => {
    const options = [
      [{ access: "public" }, { access: "public" }],
      [
        {
          access: "private",
          addRandomSuffix: true,
          allowOverwrite: false,
          contentType: "text/plain",
          cacheControlMaxAge: 120,
        },
        {
          access: "private",
          addRandomSuffix: true,
          allowOverwrite: false,
          contentType: "text/plain",
          cacheControlMaxAge: "120 seconds",
        },
      ],
      [
        { access: "public", ifMatch: '"e1"' },
        { access: "public", ifMatch: etag('"e1"') },
      ],
      [
        { access: "public", ifMatch: '"e1"', allowOverwrite: true },
        { access: "public", ifMatch: etag('"e1"'), allowOverwrite: true },
      ],
    ] as const;

    it.live("copy sends identical requests for every option", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        for (const [sdkOptions, ourOptions] of options) {
          for (const from of ["source.txt", putResponse("source.txt").url]) {
            assertSame(
              yield* compare(
                putOk,
                () =>
                  sdkOutcome(
                    () => sdk.copy(from, "copies/target.txt", sdkOptions as sdk.CopyCommandOptions),
                    sdkPutResult,
                  ),
                ourOutcome(
                  store.copy(
                    from,
                    BlobPathname.make("copies/target.txt"),
                    ourOptions as Parameters<BlobStore["Service"]["copy"]>[2],
                  ),
                  ourPutResult,
                ),
              ),
              `${from} ${JSON.stringify(sdkOptions)}`,
            );
          }
        }
      }).pipe(run()),
    );

    it.live("rename sends identical requests for every option", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        for (const [sdkOptions, ourOptions] of options) {
          for (const from of ["source.txt", putResponse("source.txt").url]) {
            assertSame(
              yield* compare(
                putOk,
                () =>
                  sdkOutcome(
                    () =>
                      sdk.rename(
                        from,
                        "renamed/target.txt",
                        sdkOptions as sdk.RenameCommandOptions,
                      ),
                    sdkPutResult,
                  ),
                ourOutcome(
                  store.rename(
                    from,
                    BlobPathname.make("renamed/target.txt"),
                    ourOptions as Parameters<BlobStore["Service"]["rename"]>[2],
                  ),
                  ourPutResult,
                ),
              ),
              `${from} ${JSON.stringify(sdkOptions)}`,
            );
          }
        }
      }).pipe(run()),
    );
  });

  describe("createFolder", () => {
    it.live("sends identical requests with and without a trailing slash and access", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const response = json({ url: `${putResponse("dir/").url}`, pathname: "dir/" });
        for (const [path, access] of [
          ["dir", undefined],
          ["dir/", undefined],
          ["nested/dir", "private"],
          ["nested/dir/", "public"],
        ] as const) {
          assertSame(
            yield* compare(
              response,
              () =>
                sdkOutcome(
                  () =>
                    access === undefined
                      ? sdk.createFolder(path)
                      : sdk.createFolder(path, { access }),
                  sdkFolderResult,
                ),
              ourOutcome(
                access === undefined
                  ? store.createFolder(BlobPathname.make(path))
                  : store.createFolder(BlobPathname.make(path), { access }),
                ourFolderResult,
              ),
            ),
            `${path} ${access}`,
          );
        }
      }).pipe(run()),
    );
  });

  describe("putImage", () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    it.live("sends identical requests for bodies and URLs (OIDC)", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const response = json(putResponse("image.webp", "image/webp"));
        const image = BlobPathname.make("image.png");
        const cases = [
          [{ width: 640 }, { width: ImageWidth.make(640) }],
          [
            { width: 64, quality: 50, format: "webp" },
            { width: ImageWidth.make(64), quality: ImageQuality.make(50), format: "webp" },
          ],
          [
            { width: 8192, format: "avif" },
            { width: ImageWidth.make(8192), format: "avif" },
          ],
        ] as const;
        for (const [sdkImage, ourImage] of cases) {
          assertSame(
            yield* compare(
              response,
              () =>
                sdkOutcome(
                  () =>
                    sdk.putImage("image.png", Buffer.from(png), {
                      access: "public",
                      optimizeImage: sdkImage,
                    }),
                  sdkPutResult,
                ),
              ourOutcome(
                store.putImage(image, png, { access: "public", optimizeImage: ourImage }),
                ourPutResult,
              ),
            ),
            `bytes ${JSON.stringify(sdkImage)}`,
          );
          assertSame(
            yield* compare(
              response,
              () =>
                sdkOutcome(
                  () =>
                    sdk.putImage("image.png", new Blob([png], { type: "image/png" }), {
                      access: "private",
                      addRandomSuffix: true,
                      allowOverwrite: true,
                      cacheControlMaxAge: 300,
                      optimizeImage: sdkImage,
                    }),
                  sdkPutResult,
                ),
              ourOutcome(
                store.putImage(image, new Blob([png], { type: "image/png" }), {
                  access: "private",
                  addRandomSuffix: true,
                  allowOverwrite: true,
                  cacheControlMaxAge: "300 seconds",
                  optimizeImage: ourImage,
                }),
                ourPutResult,
              ),
            ),
            `Blob ${JSON.stringify(sdkImage)}`,
          );
          assertSame(
            yield* compare(
              response,
              () =>
                sdkOutcome(
                  () =>
                    sdk.putImage("image.png", new URL("https://example.com/source image.png?v=1"), {
                      access: "public",
                      ifMatch: '"e1"',
                      optimizeImage: sdkImage,
                    }),
                  sdkPutResult,
                ),
              ourOutcome(
                store.putImage(image, new URL("https://example.com/source image.png?v=1"), {
                  access: "public",
                  ifMatch: etag('"e1"'),
                  optimizeImage: ourImage,
                }),
                ourPutResult,
              ),
            ),
            `URL ${JSON.stringify(sdkImage)}`,
          );
        }
      }).pipe(run(oidcSetup)),
    );

    it.live("both refuse a non-image Blob before any request", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const result = yield* compare(
          putOk,
          () =>
            sdkOutcome(
              () =>
                sdk.putImage("image.png", new Blob(["text"], { type: "text/plain" }), {
                  access: "public",
                  optimizeImage: { width: 10 },
                }),
              sdkPutResult,
            ),
          ourOutcome(
            store.putImage(
              BlobPathname.make("image.png"),
              new Blob(["text"], { type: "text/plain" }),
              { access: "public", optimizeImage: { width: ImageWidth.make(10) } },
            ),
            ourPutResult,
          ),
        );
        assert.deepStrictEqual(result.sdkRequests, []);
        assert.deepStrictEqual(result.ourRequests, []);
        assert.deepStrictEqual(result.sdk, {
          error:
            'BlobError(optimizeImage requires an image body, but the content type is "text/plain")',
        });
        assert.strictEqual(result.ours.tag, "BlobUploadRejected/ContentTypeNotAllowed");
      }).pipe(run(oidcSetup)),
    );
  });

  describe("get", () => {
    const blobPath = (server: string, access = "public") => `${server}/${access}/dir/foo.txt`;
    const found = (request: TestHttpRequest) => ({
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": "11",
        "last-modified": "Sun, 01 Mar 2026 10:00:00 GMT",
        etag: '"e1"',
        "cache-control": "public, max-age=60",
        "content-disposition": 'inline; filename="foo.txt"',
        "x-echo-url": request.url,
      },
      body: "hello world",
    });
    const notModified = {
      status: 304,
      headers: {
        "last-modified": "Sun, 01 Mar 2026 10:00:00 GMT",
        etag: '"e1"',
        "cache-control": "public, max-age=60",
      },
    };

    const getBoth = (
      access: "public" | "private",
      options: { useCache?: boolean; ifNoneMatch?: string; headers?: Record<string, string> },
      responder: Parameters<typeof compare>[0],
    ) =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const server = (yield* TestHttpServer).url;
        const url = blobPath(server, access);
        return yield* compare(
          responder,
          () => sdkOutcome(() => sdk.get(url, { access, ...options }), sdkGetResult),
          ourOutcome(store.get(url, { access, ...options }), ourGetResult),
        );
      });

    it.live("agrees on 200 for public and private blobs", () =>
      Effect.gen(function* () {
        assertSame(yield* getBoth("public", {}, found), "public");
        assertSame(yield* getBoth("private", {}, found), "private");
        assertSame(
          yield* getBoth(
            "private",
            { headers: { "x-extra": "1", authorization: "Bearer other" } },
            found,
          ),
          "header override",
        );
      }).pipe(run()),
    );

    it.live("agrees on 304 with ifNoneMatch", () =>
      Effect.gen(function* () {
        assertSame(yield* getBoth("public", { ifNoneMatch: '"e1"' }, notModified));
      }).pipe(run()),
    );

    it.live("adds cache=0 only for private blobs with useCache: false", () =>
      Effect.gen(function* () {
        const priv = yield* getBoth("private", { useCache: false }, found);
        assertSame(priv, "private");
        assert.include(priv.sdkRequests[0]?.url ?? "", "cache=0");
        const pub = yield* getBoth("public", { useCache: false }, found);
        assertSame(pub, "public");
        assert.notInclude(pub.sdkRequests[0]?.url ?? "", "cache=0");
      }).pipe(run()),
    );

    it.live("reads a pathname from the store host like the SDK reads its URL", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const server = (yield* TestHttpServer).url;
        const result = yield* compare(
          found,
          () =>
            sdkOutcome(
              () => sdk.get(blobPath(server, "private"), { access: "private", useCache: false }),
              sdkGetResult,
            ),
          ourOutcome(
            store.get("dir/foo.txt", { access: "private", useCache: false }),
            ourGetResult,
          ),
        );
        assert.deepStrictEqual(result.ourRequests, result.sdkRequests);
      }).pipe(run()),
    );

    it.live("404 is null in the SDK and BlobNotFound here (deliberate)", () =>
      Effect.gen(function* () {
        const result = yield* getBoth("public", {}, { status: 404, body: "Not Found" });
        assert.deepStrictEqual(result.ourRequests, result.sdkRequests);
        assert.deepStrictEqual(result.sdk, { ok: null });
        assert.deepStrictEqual(withoutTag(result.ours), { error: "BlobNotFoundError" });
      }).pipe(run()),
    );

    it.live("other statuses fail in both", () =>
      Effect.gen(function* () {
        for (const status of [403, 500]) {
          const result = yield* getBoth("public", {}, { status, body: "nope" });
          assert.deepStrictEqual(result.ourRequests, result.sdkRequests, String(status));
          assert.match(
            "error" in result.sdk ? result.sdk.error : "",
            new RegExp(`^BlobError\\(Failed to fetch blob: ${status} `),
          );
          assert.strictEqual(
            result.ours.tag,
            status === 403 ? "VercelApiError/ApiForbidden" : "VercelApiError/ApiServerError",
          );
        }
      }).pipe(run()),
    );
  });

  describe("multipart", () => {
    const mpuResponder = (request: TestHttpRequest) => {
      switch (request.headers["x-mpu-action"]) {
        case "create":
          return json({ key: "key/with ü", uploadId: "upload-1" });
        case "upload":
          return json({ etag: `"part-${request.headers["x-mpu-part-number"]}"` });
        default:
          return json(putResponse("big.bin", "application/octet-stream"));
      }
    };
    const big = BlobPathname.make("big.bin");

    it.live("manual create, uploadPart and complete send identical requests", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const result = yield* compare(
          mpuResponder,
          () =>
            sdkOutcome(
              async () => {
                const created = await sdk.createMultipartUpload("big.bin", {
                  access: "private",
                  addRandomSuffix: false,
                  allowOverwrite: true,
                  contentType: "application/x-test",
                  cacheControlMaxAge: 600,
                });
                const common = {
                  access: "private" as const,
                  key: created.key,
                  uploadId: created.uploadId,
                  addRandomSuffix: false,
                  allowOverwrite: true,
                  contentType: "application/x-test",
                  cacheControlMaxAge: 600,
                };
                const part1 = await sdk.uploadPart("big.bin", "part one", {
                  ...common,
                  partNumber: 1,
                });
                const part2 = await sdk.uploadPart("big.bin", Buffer.from([1, 2, 3]), {
                  ...common,
                  partNumber: 2,
                });
                const blob = await sdk.completeMultipartUpload("big.bin", [part1, part2], common);
                return { created, parts: [part1, part2], blob: sdkPutResult(blob) };
              },
              (value) => value,
            ),
          ourOutcome(
            Effect.gen(function* () {
              const upload = yield* store.createMultipartUpload(big, {
                access: "private",
                addRandomSuffix: false,
                allowOverwrite: true,
                contentType: "application/x-test",
                cacheControlMaxAge: "600 seconds",
              });
              const part1 = yield* store.uploadPart(upload, PartNumber.make(1), "part one");
              const part2 = yield* store.uploadPart(
                upload,
                PartNumber.make(2),
                new Uint8Array([1, 2, 3]),
              );
              const blob = yield* store.completeMultipartUpload(upload, [part1, part2]);
              return {
                created: { key: upload.key, uploadId: upload.uploadId },
                parts: [
                  { etag: part1.etag, partNumber: part1.partNumber as number },
                  { etag: part2.etag, partNumber: part2.partNumber as number },
                ],
                blob: ourPutResult(blob),
              };
            }),
            (value) => value,
          ),
        );
        assertSame(result);
      }).pipe(run()),
    );

    it.live("manual multipart with ifMatch sends identical requests", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const result = yield* compare(
          mpuResponder,
          () =>
            sdkOutcome(
              async () => {
                const created = await sdk.createMultipartUpload("big.bin", {
                  access: "public",
                  ifMatch: '"e1"',
                });
                const common = {
                  access: "public" as const,
                  key: created.key,
                  uploadId: created.uploadId,
                  ifMatch: '"e1"',
                };
                const part = await sdk.uploadPart("big.bin", "p", { ...common, partNumber: 1 });
                return sdkPutResult(await sdk.completeMultipartUpload("big.bin", [part], common));
              },
              (value) => value,
            ),
          ourOutcome(
            Effect.gen(function* () {
              const upload = yield* store.createMultipartUpload(big, {
                access: "public",
                ifMatch: etag('"e1"'),
              });
              const part = yield* store.uploadPart(upload, PartNumber.make(1), "p");
              return yield* store.completeMultipartUpload(upload, [part]);
            }),
            ourPutResult,
          ),
        );
        assertSame(result);
      }).pipe(run()),
    );

    it.live("put({ multipart: true }) over 8 MiB sends identical parts", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const body = new Uint8Array(8 * 1024 * 1024 + 1024);
        for (let i = 0; i < body.length; i++) body[i] = (i * 31) % 251;
        const result = yield* compare(
          mpuResponder,
          () =>
            sdkOutcome(
              () =>
                sdk.put("big.bin", Buffer.from(body), {
                  access: "public",
                  multipart: true,
                  contentType: "application/octet-stream",
                }),
              sdkPutResult,
            ),
          ourOutcome(
            store.put(big, body, {
              access: "public",
              multipart: true,
              contentType: "application/octet-stream",
            }),
            ourPutResult,
          ),
        );
        const normalize = (requests: Comparison<unknown>["sdkRequests"]) =>
          sortParts(requests).map(sortCompletionBody);
        assert.strictEqual(result.sdkRequests.length, 4);
        assert.deepStrictEqual(normalize(result.ourRequests), normalize(result.sdkRequests));
        assert.deepStrictEqual(withoutTag(result.ours), result.sdk);
      }).pipe(run()),
    );

    it.live("put({ multipart: true }) of a stream sends identical parts", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const stream = streamOf(["first chunk ", "second chunk"]);
        const result = yield* compare(
          mpuResponder,
          () =>
            sdkOutcome(
              () => sdk.put("big.bin", stream.sdk(), { access: "public", multipart: true }),
              sdkPutResult,
            ),
          ourOutcome(
            store.put(big, stream.ours(), { access: "public", multipart: true }),
            ourPutResult,
          ),
        );
        assertSame(result);
      }).pipe(run()),
    );
  });

  describe("authentication", () => {
    const authBoth = Effect.gen(function* () {
      const store = yield* BlobStore;
      return [
        yield* compare(
          putOk,
          () => sdkOutcome(() => sdk.put(pathname, "x", { access: "public" }), sdkPutResult),
          ourOutcome(store.put(pathname, "x", { access: "public" }), ourPutResult),
        ),
        yield* compare(
          json(headResponse),
          () => sdkOutcome(() => sdk.head("foo.txt"), sdkHeadResult),
          ourOutcome(store.head("foo.txt"), ourHeadResult),
        ),
        yield* compare(
          json({ blobs: [], hasMore: false }),
          () => sdkOutcome(() => sdk.list({ prefix: "a/" }), sdkListResult),
          ourOutcome(store.list({ prefix: "a/" }), ourListResult),
        ),
      ] as const;
    });

    it.live("sends the OIDC token and the configured store id", () =>
      Effect.gen(function* () {
        for (const result of yield* authBoth) {
          assertSame(result);
          assert.strictEqual(result.sdkRequests[0]?.headers.authorization, `Bearer ${oidcToken}`);
          assert.strictEqual(result.sdkRequests[0]?.headers["x-vercel-blob-store-id"], oidcStoreId);
          assert.strictEqual(
            result.sdkRequests[0]?.headers["x-api-blob-request-id"],
            `${oidcStoreId}:<epoch-ms>:<hex>`,
          );
        }
      }).pipe(run(oidcSetup)),
    );

    it.live("falls back to the read-write token without an OIDC token", () =>
      Effect.gen(function* () {
        for (const result of yield* authBoth) {
          assertSame(result);
          assert.strictEqual(
            result.sdkRequests[0]?.headers.authorization,
            `Bearer ${readWriteToken}`,
          );
          assert.strictEqual(result.sdkRequests[0]?.headers["x-vercel-blob-store-id"], storeId);
        }
      }).pipe(run(oidcFallbackSetup)),
    );

    it.live("get uses the OIDC token too", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const url = `${(yield* TestHttpServer).url}/public/foo.txt`;
        const result = yield* compare(
          { status: 200, headers: { "last-modified": "Sun, 01 Mar 2026 10:00:00 GMT" }, body: "x" },
          () => sdkOutcome(() => sdk.get(url, { access: "public" }), sdkGetResult),
          ourOutcome(store.get(url, { access: "public" }), ourGetResult),
        );
        assertSame(result);
        assert.strictEqual(result.sdkRequests[0]?.headers.authorization, `Bearer ${oidcToken}`);
      }).pipe(run(oidcSetup)),
    );
  });

  describe("errors", () => {
    type Op = {
      readonly name: string;
      /** Domain errors the operation's contract declares. */
      readonly declares: ReadonlyArray<string>;
      readonly sdk: () => Promise<unknown>;
      readonly ours: (store: BlobStore["Service"]) => Effect.Effect<unknown, unknown>;
      readonly setup?: Setup;
    };
    const request = ["BlobStoreUnavailable", "BlobOidcEnvironmentNotAllowed"];
    const write = [...request, "BlobPreconditionFailed", "BlobUploadRejected"];
    const ops: ReadonlyArray<Op> = [
      {
        name: "put (PUT /?pathname)",
        declares: write,
        sdk: () => sdk.put(pathname, "x", { access: "public" }),
        ours: (store) => store.put(pathname, "x", { access: "public" }),
      },
      {
        name: "head (GET ?url)",
        declares: [...request, "BlobNotFound"],
        sdk: () => sdk.head("foo.txt"),
        ours: (store) => store.head("foo.txt"),
      },
      {
        name: "list (GET ?limit)",
        declares: request,
        sdk: () => sdk.list({ limit: 5 }),
        ours: (store) => store.list({ limit: 5 }),
      },
      {
        name: "del (POST /delete)",
        declares: [...request, "BlobPreconditionFailed"],
        sdk: () => sdk.del("foo.txt"),
        ours: (store) => store.del("foo.txt"),
      },
      {
        name: "copy (PUT ?pathname&fromUrl)",
        declares: [...write, "BlobNotFound"],
        sdk: () => sdk.copy("a.txt", "b.txt", { access: "public" }),
        ours: (store) => store.copy("a.txt", BlobPathname.make("b.txt"), { access: "public" }),
      },
      {
        name: "rename (POST /rename)",
        declares: [...write, "BlobNotFound"],
        sdk: () => sdk.rename("a.txt", "b.txt", { access: "public" }),
        ours: (store) => store.rename("a.txt", BlobPathname.make("b.txt"), { access: "public" }),
      },
      {
        name: "putImage (POST /put-optimized)",
        declares: write,
        sdk: () =>
          sdk.putImage("i.png", Buffer.from([1]), {
            access: "public",
            optimizeImage: { width: 1 },
          }),
        ours: (store) =>
          store.putImage(BlobPathname.make("i.png"), new Uint8Array([1]), {
            access: "public",
            optimizeImage: { width: ImageWidth.make(1) },
          }),
        setup: oidcSetup,
      },
      {
        name: "createMultipartUpload (POST /mpu)",
        declares: write,
        sdk: () => sdk.createMultipartUpload("big.bin", { access: "public" }),
        ours: (store) =>
          store.createMultipartUpload(BlobPathname.make("big.bin"), { access: "public" }),
      },
    ];

    const expectedOurs = (row: ErrorMappingRow, op: Op) =>
      row.domain === undefined || op.declares.includes(row.domain)
        ? { error: row.sdk }
        : { error: row.undeclared ?? row.sdk };

    for (const op of ops) {
      it.live(`${op.name}: every error code maps like the SDK's`, () =>
        Effect.gen(function* () {
          const store = yield* BlobStore;
          for (const row of errorMapping) {
            const result = yield* compare(
              row.response,
              () => sdkOutcome(op.sdk, () => "ok"),
              ourOutcome(op.ours(store), () => "ok"),
            );
            assert.deepStrictEqual(result.ourRequests, result.sdkRequests, `${row.name}: requests`);
            assert.strictEqual(result.sdkRequests.length, 1, `${row.name}: attempts`);
            assert.deepStrictEqual(result.sdk, { error: row.sdk }, `${row.name}: SDK`);
            assert.deepStrictEqual(withoutTag(result.ours), expectedOurs(row, op), row.name);
            if (row.domain === undefined || op.declares.includes(row.domain)) {
              assert.strictEqual(result.ours.tag, row.ours, `${row.name}: tag`);
            }
          }
        }).pipe(run(op.setup)),
      );
    }
  });

  describe("retries", () => {
    it.effect("retries a retryable error with the same request id and increasing attempts", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const server = yield* TestHttpServer;
        const failing = {
          status: 503,
          headers: { "content-type": "application/json" },
          body: '{"error":{"code":"service_unavailable"}}',
        };
        const respond = () => {
          let calls = 0;
          return () => (calls++ < 2 ? failing : putOk);
        };
        yield* server.setHandler(respond());
        const before = (yield* server.requests).length;

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const sdkResult = yield* Effect.promise(async () => {
          let settled = false;
          const promise = sdk.put(pathname, "x", { access: "public" }).then(
            (value) => sdkPutResult(value),
            (error: unknown) => ({ error: String(error) }),
          );
          void promise.finally(() => {
            settled = true;
          });
          while (!settled) await vi.advanceTimersByTimeAsync(250);
          return promise;
        }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
        const middle = (yield* server.requests).length;

        yield* server.setHandler(respond());
        const fiber = yield* Effect.forkChild(store.put(pathname, "x", { access: "public" }));
        let ours = fiber.pollUnsafe();
        while (ours === undefined) {
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
          yield* TestClock.adjust("250 millis");
          ours = fiber.pollUnsafe();
        }
        const ourResult = ourPutResult(yield* Fiber.join(fiber));
        const requests = yield* server.requests;

        const attempts = (slice: ReadonlyArray<TestHttpRequest>) =>
          slice.map((r) => [
            r.headers["x-api-blob-request-attempt"],
            r.headers["x-api-blob-request-id"],
          ]);
        const sdkAttempts = attempts(requests.slice(before, middle));
        const ourAttempts = attempts(requests.slice(middle));
        assert.deepStrictEqual(sdkResult, ourResult);
        assert.deepStrictEqual(
          sdkAttempts.map(([attempt]) => attempt),
          ["0", "1", "2"],
        );
        assert.deepStrictEqual(
          ourAttempts.map(([attempt]) => attempt),
          sdkAttempts.map(([attempt]) => attempt),
        );
        assert.strictEqual(new Set(sdkAttempts.map(([, id]) => id)).size, 1, "SDK id constant");
        assert.strictEqual(new Set(ourAttempts.map(([, id]) => id)).size, 1, "our id constant");
      }).pipe(run({ auth: "readWrite", retries: 2 })),
    );

    it.live("does not retry rate limits or domain errors", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        for (const response of [
          {
            status: 429,
            headers: { "content-type": "application/json" },
            body: '{"error":{"code":"rate_limited"}}',
          },
          {
            status: 403,
            headers: { "content-type": "application/json" },
            body: '{"error":{"code":"store_suspended"}}',
          },
        ]) {
          const result = yield* compare(
            response,
            () => sdkOutcome(() => sdk.put(pathname, "x", { access: "public" }), sdkPutResult),
            ourOutcome(store.put(pathname, "x", { access: "public" }), ourPutResult),
          );
          assertSame(result);
          assert.strictEqual(result.sdkRequests.length, 1);
        }
      }).pipe(run({ auth: "readWrite", retries: 2 })),
    );
  });
});
