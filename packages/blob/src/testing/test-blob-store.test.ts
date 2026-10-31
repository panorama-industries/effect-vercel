import { assert, describe, it } from "@effect/vitest";
import { ApiServerError, VercelApiError } from "@panorama-industries/effect-vercel-core";
import { Context, DateTime, Effect, Exit, Option, Predicate, Random, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { UploadProgress } from "../contracts/blob-domain.ts";

import {
  BlobPathname,
  ETag,
  GetBlobResult,
  PartNumber,
  StoreId,
} from "../contracts/blob-domain.ts";
import { BlobNotFound } from "../contracts/blob-errors.ts";
import { BlobStore, ImageWidth } from "../contracts/blob-store.ts";
import { TestBlobStore } from "./test-blob-store.ts";

const path = (pathname: string) => BlobPathname.make(pathname);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")),
  );
const base = "https://teststore.public.blob.vercel-storage.com";

/** The content of a `get` result, which must be `Found`. */
const foundText = (result: GetBlobResult) =>
  GetBlobResult.$is("Found")(result) ? text(result.body) : Effect.die("expected Found");

const putText = (pathname: string, body: string) =>
  BlobStore.use((store) => store.put(path(pathname), body, { access: "public" }));

/** The `ApiBadRequest` message of a failure, or none. */
const badRequestMessage = (error: unknown): Option.Option<string> =>
  Predicate.isTagged(error, "VercelApiError") &&
  Predicate.isTagged((error as VercelApiError).reason, "ApiBadRequest")
    ? Option.some((error as VercelApiError).reason.message)
    : Option.none();

describe("TestBlobStore", () => {
  describe("put", () => {
    it.effect("stores a blob and reports it like the store", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* TestClock.adjust("1 hour");
        const result = yield* store.put(path("docs/readme.txt"), "hello", { access: "public" });
        assert.strictEqual(result.url.href, `${base}/docs/readme.txt`);
        assert.strictEqual(result.downloadUrl.href, `${base}/docs/readme.txt?download=1`);
        assert.strictEqual(result.pathname, "docs/readme.txt");
        assert.strictEqual(result.contentType, "text/plain");
        assert.strictEqual(result.contentDisposition, 'inline; filename="readme.txt"');

        const head = yield* store.head("docs/readme.txt");
        assert.strictEqual(head.size, 5);
        assert.strictEqual(head.etag, result.etag);
        assert.strictEqual(head.cacheControl, "public, max-age=2592000");
        assert.strictEqual(DateTime.toEpochMillis(head.uploadedAt), 3_600_000);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("infers the media type from the extension, then from the body", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const put = (pathname: string, body: string | Uint8Array | globalThis.Blob) =>
          store.put(path(pathname), body, { access: "public" });
        const image = yield* put("a.PNG", bytes("x"));
        assert.strictEqual(image.contentType, "image/png");
        assert.strictEqual(image.contentDisposition, 'inline; filename="a.PNG"');
        assert.strictEqual((yield* put("a.js", "x")).contentType, "application/javascript");
        assert.strictEqual(
          (yield* put("b.txt", new globalThis.Blob(["x"], { type: "image/png" }))).contentType,
          "text/plain",
        );
        assert.strictEqual((yield* put("data", "x")).contentType, "text/plain;charset=UTF-8");
        assert.strictEqual(
          (yield* put("bytes", bytes("x"))).contentType,
          "application/octet-stream",
        );
        assert.strictEqual(
          (yield* put("typed", new globalThis.Blob(["x"], { type: "image/png" }))).contentType,
          "image/png",
        );
        const dotfile = yield* put("dir/.env", bytes("x"));
        assert.strictEqual(dotfile.contentType, "application/octet-stream");
        const multipart = yield* store.put(path("parts"), "x", {
          access: "public",
          multipart: true,
        });
        assert.strictEqual(multipart.contentType, "application/octet-stream");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("serves media, plain text, JSON, XML and PDF inline with an encoded filename", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const disposition = (pathname: string, contentType?: string) =>
          Effect.map(
            store.put(path(pathname), "x", {
              access: "public",
              ...(contentType === undefined ? {} : { contentType }),
            }),
            (result) => result.contentDisposition,
          );
        assert.strictEqual(yield* disposition("a.svg"), 'inline; filename="a.svg"');
        assert.strictEqual(yield* disposition("a.pdf"), 'inline; filename="a.pdf"');
        assert.strictEqual(yield* disposition("a.json"), 'inline; filename="a.json"');
        assert.strictEqual(yield* disposition("x", "text/xml"), 'inline; filename="x"');
        assert.strictEqual(yield* disposition("p", "image/png; q=1"), 'inline; filename="p"');
        assert.strictEqual(yield* disposition("a.html"), 'attachment; filename="a.html"');
        assert.strictEqual(yield* disposition("a.js"), 'attachment; filename="a.js"');
        assert.strictEqual(yield* disposition("data"), 'attachment; filename="data"');
        assert.strictEqual(
          yield* disposition("t", "text/plain; charset=utf-8"),
          'attachment; filename="t"',
        );
        assert.strictEqual(yield* disposition("u", "IMAGE/PNG"), 'attachment; filename="u"');
        assert.strictEqual(
          yield* disposition('dir/a "b" ü.txt'),
          'inline; filename="a%20%22b%22%20%C3%BC.txt"',
        );
        const given = yield* store.put(path("b.txt"), "x", {
          access: "public",
          contentType: "video/mp4",
        });
        assert.strictEqual(given.contentType, "video/mp4");
        assert.strictEqual(given.contentDisposition, 'inline; filename="b.txt"');
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("serves a private store's blobs from the private host, cached as public", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const result = yield* store.put(path("secret.json"), "{}", {
          access: "private",
          cacheControlMaxAge: "1 hour",
        });
        assert.strictEqual(
          result.url.href,
          "https://teststore.private.blob.vercel-storage.com/secret.json",
        );
        const head = yield* store.head(result.url);
        assert.strictEqual(head.cacheControl, "public, max-age=3600");
        assert.strictEqual(head.contentType, "application/json");
      }).pipe(Effect.provide(TestBlobStore.layerWith({ access: "private" }))),
    );

    it.effect("refuses writes with the other access than the store's", () =>
      Effect.gen(function* () {
        const publicStore = yield* store("public").pipe(Effect.flip);
        assert.deepStrictEqual(
          badRequestMessage(publicStore),
          Option.some(
            "Cannot use private access on a public store. The store must be configured with private access.",
          ),
        );
        const privateStore = yield* store("private").pipe(Effect.flip);
        assert.deepStrictEqual(
          badRequestMessage(privateStore),
          Option.some(
            "Cannot use public access on a private store. The store is configured with private access.",
          ),
        );
        const folder = yield* BlobStore.use((blobs) => blobs.createFolder(path("f"))).pipe(
          Effect.provide(TestBlobStore.layerWith({ access: "private" })),
          Effect.flip,
        );
        assert.isTrue(Option.isSome(badRequestMessage(folder)));

        function store(access: "public" | "private") {
          return BlobStore.use((blobs) =>
            blobs.put(path("a.txt"), "x", { access: access === "public" ? "private" : "public" }),
          ).pipe(Effect.provide(TestBlobStore.layerWith({ access })));
        }
      }),
    );

    it.effect("refuses an existing pathname unless overwriting is allowed", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const first = yield* putText("a.txt", "one");
        const refused = yield* putText("a.txt", "two").pipe(Effect.flip);
        assert.strictEqual(refused._tag, "VercelApiError");
        assert.deepStrictEqual((refused as VercelApiError).errorCode, Option.some("bad_request"));
        assert.deepStrictEqual(
          badRequestMessage(refused),
          Option.some(
            "This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename. Read more about this error in our documentation: https://vercel.link/blob-allow-overwrite",
          ),
        );
        const explicit = yield* store
          .put(path("a.txt"), "two", { access: "public", allowOverwrite: false })
          .pipe(Effect.flip);
        assert.isTrue(Option.isSome(badRequestMessage(explicit)));

        const second = yield* store.put(path("a.txt"), "two", {
          access: "public",
          allowOverwrite: true,
        });
        assert.notStrictEqual(second.etag, first.etag);
        const found = yield* store.get("a.txt", { access: "public" });
        assert.strictEqual(yield* foundText(found), "two");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("changes the ETag on every write, even of the same content", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const etags = new Set<string>();
        for (let index = 0; index < 3; index++) {
          const result = yield* store.put(path("same.txt"), "same", {
            access: "public",
            allowOverwrite: true,
          });
          etags.add(result.etag);
        }
        assert.strictEqual(etags.size, 3);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("replaces only the blob with the ETag given as ifMatch", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const first = yield* putText("a.txt", "one");
        const stale = yield* store
          .put(path("a.txt"), "two", { access: "public", ifMatch: ETag.make('"other"') })
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "BlobPreconditionFailed");

        const missing = yield* store
          .put(path("b.txt"), "two", { access: "public", ifMatch: first.etag })
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "BlobPreconditionFailed");

        const bare = ETag.make(first.etag.replaceAll('"', ""));
        const second = yield* store.put(path("a.txt"), "two", { access: "public", ifMatch: bare });
        assert.notStrictEqual(second.etag, first.etag);
        const replaced = yield* store
          .put(path("a.txt"), "three", { access: "public", ifMatch: first.etag })
          .pipe(Effect.flip);
        assert.strictEqual(replaced._tag, "BlobPreconditionFailed");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("appends a random suffix from Random before the extension", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const suffixed = (pathname: string) =>
          store
            .put(path(pathname), "x", { access: "public", addRandomSuffix: true })
            .pipe(Effect.map((result) => result.pathname));
        const a = yield* suffixed("photos/cat.jpg");
        assert.match(a, /^photos\/cat-[A-Za-z0-9]{30}\.jpg$/);
        const b = yield* suffixed("photos/cat.jpg");
        assert.notStrictEqual(a, b);
        assert.match(yield* suffixed("notes"), /^notes-[A-Za-z0-9]{30}$/);

        const seeded = yield* suffixed("seeded.txt").pipe(Random.withSeed("seed"));
        const again = yield* store
          .put(path("seeded.txt"), "x", { access: "public", addRandomSuffix: true })
          .pipe(Random.withSeed("seed"), Effect.flip);
        // The same seed yields the same pathname, which now exists.
        assert.isTrue(Option.isSome(badRequestMessage(again)));
        const head = yield* store.head(seeded);
        assert.strictEqual(head.pathname, seeded);
        assert.strictEqual(head.contentType, "text/plain");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("consumes stream bodies and propagates their requirements", () =>
      Effect.gen(function* () {
        class Prefix extends Context.Service<Prefix, string>()("test/Prefix") {}
        const store = yield* BlobStore;
        const body = Stream.fromEffect(Prefix.useSync((prefix) => prefix)).pipe(
          Stream.map(bytes),
          Stream.concat(Stream.fromIterable([bytes(" world")])),
        );
        const result = yield* store
          .put(path("stream.txt"), body, { access: "public" })
          .pipe(Effect.provideService(Prefix, "hello"));
        const head = yield* store.head(result.url);
        assert.strictEqual(head.size, 11);
        const found = yield* store.get("stream.txt", { access: "public" });
        assert.strictEqual(yield* foundText(found), "hello world");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("fails with the stream's error and stores nothing", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        const body = Stream.concat(
          Stream.succeed(bytes("partial")),
          Stream.fail("broken" as const),
        );
        const error = yield* store
          .put(path("broken.txt"), body, { access: "public" })
          .pipe(Effect.flip);
        assert.strictEqual(error, "broken");
        assert.deepStrictEqual(yield* control.blobs, []);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("reads Blob bodies", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const result = yield* store.put(path("file.bin"), new Blob([bytes("blob body")]), {
          access: "public",
        });
        const found = yield* store.get(result.url, { access: "public" });
        assert.strictEqual(yield* foundText(found), "blob body");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("reports 0 % before the upload and 100 % once stored", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const events = yield* Ref.make<ReadonlyArray<UploadProgress>>([]);
        const onUploadProgress = (event: UploadProgress) =>
          Ref.update(events, (all) => [...all, event]);
        yield* store.put(path("p.txt"), "12345", { access: "public", onUploadProgress });
        yield* store.put(path("m.txt"), "123", {
          access: "public",
          multipart: true,
          onUploadProgress,
        });
        assert.deepStrictEqual(yield* Ref.get(events), [
          { loaded: 0, total: 5, percentage: 0 },
          { loaded: 5, total: 5, percentage: 100 },
          { loaded: 0, total: 3, percentage: 0 },
          { loaded: 3, total: 3, percentage: 100 },
        ]);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("uploads with automatic multipart and checks the maximum size first", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        const result = yield* store.put(path("big.bin"), Stream.make(bytes("ab"), bytes("cd")), {
          access: "public",
          multipart: true,
          maximumSizeInBytes: 1,
        });
        assert.strictEqual(result.pathname, "big.bin");
        const stored = yield* control.blob("big.bin");
        assert.strictEqual(
          new TextDecoder().decode(Option.getOrThrow(stored).body),
          "abcd",
          "streams of unknown size are not checked",
        );

        const tooLarge = yield* store
          .put(path("small.bin"), "abcd", {
            access: "public",
            multipart: true,
            maximumSizeInBytes: 3,
          })
          .pipe(Effect.flip);
        assert.isTrue(
          Predicate.isTagged(tooLarge, "BlobUploadRejected") &&
            Predicate.isTagged(tooLarge.reason, "FileTooLarge"),
        );
        assert.isTrue(Option.isNone(yield* control.blob("small.bin")));
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );
  });

  describe("head and get", () => {
    it.effect("fail with BlobNotFound for missing blobs", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const locator = yield* store.head("missing.txt").pipe(
          Effect.flatMap(() => Effect.die("expected BlobNotFound")),
          Effect.catchTag("BlobNotFound", (error) => Effect.succeed(error.locator)),
        );
        assert.strictEqual(locator, "missing.txt");
        const get = yield* store.get("missing.txt", { access: "public" }).pipe(Effect.flip);
        assert.strictEqual(get._tag, "BlobNotFound");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("returns the content as a stream with the blob's headers", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const put = yield* putText("hello.txt", "hello");
        const result = yield* store.get("hello.txt", { access: "public" });
        if (!GetBlobResult.$is("Found")(result)) return assert.fail("expected Found");
        assert.strictEqual(result.contentType, "text/plain");
        assert.strictEqual(result.size, 5);
        assert.strictEqual(result.blob.url.href, put.url.href);
        assert.strictEqual(result.blob.downloadUrl.href, put.downloadUrl.href);
        assert.strictEqual(result.blob.etag, put.etag);
        assert.strictEqual(result.blob.contentDisposition, put.contentDisposition);
        assert.strictEqual(result.headers["etag"], put.etag);
        assert.strictEqual(result.headers["content-length"], "5");
        assert.strictEqual(result.headers["last-modified"], "Thu, 01 Jan 1970 00:00:00 GMT");
        assert.strictEqual(yield* text(result.body), "hello");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("returns NotModified when ifNoneMatch is the current ETag", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const put = yield* putText("hello.txt", "hello");
        const same = yield* store.get("hello.txt", { access: "public", ifNoneMatch: put.etag });
        assert.strictEqual(same._tag, "NotModified");
        assert.strictEqual(same.blob.etag, put.etag);
        const other = yield* store.get("hello.txt", { access: "public", ifNoneMatch: '"x"' });
        assert.strictEqual(other._tag, "Found");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("finds a blob only under its access and this store's host", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const put = yield* store.put(path("private.txt"), "x", { access: "private" });
        const wrongAccess = yield* store.get("private.txt", { access: "public" }).pipe(Effect.flip);
        assert.strictEqual(wrongAccess._tag, "BlobNotFound");
        assert.strictEqual((yield* store.get(put.url, { access: "public" }))._tag, "Found");
        const publicHost = new URL(`${base}/private.txt`);
        assert.strictEqual((yield* store.head(publicHost).pipe(Effect.flip))._tag, "BlobNotFound");
        const otherStore = "https://other.private.blob.vercel-storage.com/private.txt";
        assert.strictEqual(
          (yield* store.get(otherStore, { access: "private" }).pipe(Effect.flip))._tag,
          "BlobNotFound",
        );
      }).pipe(Effect.provide(TestBlobStore.layerWith({ access: "private" }))),
    );

    it.effect("resolves percent-encoded URLs and ignores their query", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const put = yield* putText("with space.txt", "x");
        assert.strictEqual(put.url.href, `${base}/with%20space.txt`);
        assert.strictEqual((yield* store.head(put.downloadUrl)).pathname, "with space.txt");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("treats URLs outside Vercel Blob as a defect in get, like BlobStoreLive", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const exit = yield* store
          .get("https://example.com/a.txt", { access: "public" })
          .pipe(Effect.exit);
        assert.isTrue(Exit.hasDies(exit));
        const empty = yield* store.get("", { access: "public" }).pipe(Effect.exit);
        assert.isTrue(Exit.hasDies(empty));
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );
  });

  describe("list", () => {
    const seed = Effect.gen(function* () {
      for (const pathname of ["b.txt", "a/2.txt", "a/1.txt", "a/sub/x.txt", "c.txt", "a/"]) {
        yield* putText(pathname, pathname);
      }
    });

    it.effect("lists blobs in lexicographic order with a prefix", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* seed;
        const all = yield* store.list();
        assert.deepStrictEqual(
          all.blobs.map((blob) => blob.pathname),
          ["a/", "a/1.txt", "a/2.txt", "a/sub/x.txt", "b.txt", "c.txt"],
        );
        assert.deepStrictEqual(all.folders, []);
        assert.isFalse(all.hasMore);
        assert.isTrue(Option.isNone(all.cursor));
        const prefixed = yield* store.list({ prefix: "a/" });
        assert.deepStrictEqual(
          prefixed.blobs.map((blob) => blob.pathname),
          ["a/", "a/1.txt", "a/2.txt", "a/sub/x.txt"],
        );
        const listed = all.blobs[1]!;
        assert.strictEqual(listed.size, 7);
        assert.strictEqual(listed.url.href, `${base}/a/1.txt`);
        assert.strictEqual(listed.downloadUrl.href, `${base}/a/1.txt?download=1`);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("pages with limit and cursor", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* seed;
        const first = yield* store.list({ limit: 4 });
        assert.deepStrictEqual(
          first.blobs.map((blob) => blob.pathname),
          ["a/", "a/1.txt", "a/2.txt", "a/sub/x.txt"],
        );
        assert.isTrue(first.hasMore);
        const second = yield* store.list({ limit: 4, cursor: Option.getOrThrow(first.cursor) });
        assert.deepStrictEqual(
          second.blobs.map((blob) => blob.pathname),
          ["b.txt", "c.txt"],
        );
        assert.isFalse(second.hasMore);
        assert.isTrue(Option.isNone(second.cursor));
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("folds folders directly under the prefix, fully qualified", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* seed;
        const root = yield* store.list({ mode: "folded" });
        assert.deepStrictEqual(root.folders, ["a/"]);
        assert.deepStrictEqual(
          root.blobs.map((blob) => blob.pathname),
          ["b.txt", "c.txt"],
        );
        const nested = yield* store.list({ mode: "folded", prefix: "a/" });
        assert.deepStrictEqual(nested.folders, ["a/sub/"]);
        assert.deepStrictEqual(
          nested.blobs.map((blob) => blob.pathname),
          ["a/", "a/1.txt", "a/2.txt"],
        );

        const firstPage = yield* store.list({ mode: "folded", limit: 1 });
        assert.deepStrictEqual(firstPage.folders, ["a/"]);
        assert.deepStrictEqual(firstPage.blobs, []);
        const rest = yield* store.list({
          mode: "folded",
          cursor: Option.getOrThrow(firstPage.cursor),
        });
        assert.deepStrictEqual(rest.folders, []);
        assert.deepStrictEqual(
          rest.blobs.map((blob) => blob.pathname),
          ["b.txt", "c.txt"],
        );
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("listAll streams every match across pages", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        yield* seed;
        const all = yield* Stream.runCollect(store.listAll({ limit: 2 }));
        assert.deepStrictEqual(
          all.map((blob) => blob.pathname),
          ["a/", "a/1.txt", "a/2.txt", "a/sub/x.txt", "b.txt", "c.txt"],
        );
        const pages = (yield* control.calls).filter((entry) => entry.operation === "list");
        assert.strictEqual(pages.length, 3);
        const prefixed = yield* Stream.runCollect(store.listAll({ prefix: "a/sub" }));
        assert.deepStrictEqual(
          prefixed.map((blob) => blob.pathname),
          ["a/sub/x.txt"],
        );
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );
  });

  describe("del", () => {
    it.effect("deletes by pathname or URL and succeeds for missing blobs", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        const a = yield* putText("a.txt", "a");
        yield* putText("b.txt", "b");
        yield* putText("c.txt", "c");
        yield* store.del(a.url);
        yield* store.del("b.txt");
        yield* store.del("missing.txt");
        assert.deepStrictEqual(
          (yield* control.blobs).map((blob) => blob.pathname),
          ["c.txt"],
        );
        yield* store.delMany(["c.txt", "missing.txt", `${base}/nothing`]);
        assert.deepStrictEqual(yield* control.blobs, []);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("deletes with ifMatch only when the ETag matches", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        const a = yield* putText("a.txt", "a");
        const stale = yield* store
          .del("a.txt", { ifMatch: ETag.make('"stale"') })
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "BlobPreconditionFailed");
        assert.isTrue(Option.isSome(yield* control.blob("a.txt")));
        const missing = yield* store.del("b.txt", { ifMatch: a.etag }).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "BlobPreconditionFailed");
        yield* store.del("a.txt", { ifMatch: a.etag });
        assert.isTrue(Option.isNone(yield* control.blob("a.txt")));
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );
  });

  describe("copy and rename", () => {
    it.effect("copy keeps the source and does not inherit its media type or cache lifetime", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.put(path("src.json"), "{}", {
          access: "public",
          contentType: "text/csv",
          cacheControlMaxAge: "1 hour",
        });
        const copied = yield* store.copy("src.json", path("dst.txt"), { access: "public" });
        assert.strictEqual(copied.pathname, "dst.txt");
        assert.strictEqual(copied.contentType, "text/plain");
        assert.strictEqual(copied.url.href, `${base}/dst.txt`);
        const head = yield* store.head(copied.url);
        assert.strictEqual(head.cacheControl, "public, max-age=2592000");
        assert.strictEqual(head.size, 2);
        assert.isTrue((yield* store.head("src.json")).size === 2);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect(
      "copy fails for a missing source or a stale ifMatch, and replaces the destination",
      () =>
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const missing = yield* store
            .copy("nope.txt", path("dst.txt"), { access: "public" })
            .pipe(Effect.flip);
          assert.deepStrictEqual(missing, new BlobNotFound({ locator: "nope.txt" }));

          const src = yield* putText("src.txt", "src");
          yield* putText("dst.txt", "dst");
          const overwritten = yield* store.copy(src.url, path("dst.txt"), {
            access: "public",
            allowOverwrite: false,
          });
          assert.strictEqual(
            yield* foundText(yield* store.get(overwritten.url, { access: "public" })),
            "src",
          );
          const stale = yield* store
            .copy("src.txt", path("dst.txt"), {
              access: "public",
              allowOverwrite: true,
              ifMatch: ETag.make('"stale"'),
            })
            .pipe(Effect.flip);
          assert.strictEqual(stale._tag, "BlobPreconditionFailed");
          const replaced = yield* store.copy("src.txt", path("dst.txt"), {
            access: "public",
            allowOverwrite: true,
            ifMatch: src.etag,
          });
          const found = yield* store.get(replaced.url, { access: "public" });
          assert.strictEqual(yield* foundText(found), "src");
        }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("rename moves the blob and fails for a missing source", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        yield* putText("old.txt", "content");
        const renamed = yield* store.rename("old.txt", path("new/name.txt"), {
          access: "public",
        });
        assert.strictEqual(renamed.pathname, "new/name.txt");
        assert.deepStrictEqual(
          (yield* control.blobs).map((blob) => blob.pathname),
          ["new/name.txt"],
        );
        const missing = yield* store
          .rename("old.txt", path("other.txt"), { access: "public" })
          .pipe(Effect.flip);
        assert.deepStrictEqual(missing, new BlobNotFound({ locator: "old.txt" }));

        yield* putText("a.txt", "a");
        const exists = yield* store
          .rename("a.txt", path("new/name.txt"), { access: "public" })
          .pipe(Effect.flip);
        assert.isTrue(Option.isSome(badRequestMessage(exists)));
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );
  });

  describe("createFolder", () => {
    it.effect("creates an empty entry ending in a slash", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const folder = yield* store.createFolder(path("photos"));
        assert.strictEqual(folder.pathname, "photos/");
        assert.strictEqual(folder.url.href, `${base}/photos/`);
        const again = yield* store
          .createFolder(path("photos/"), { access: "public" })
          .pipe(Effect.flip);
        assert.isTrue(Option.isSome(badRequestMessage(again)));
        assert.strictEqual((yield* store.head("photos/")).size, 0);
        assert.deepStrictEqual((yield* store.list({ mode: "folded" })).folders, ["photos/"]);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );
  });

  describe("putImage", () => {
    const optimizeImage = { width: ImageWidth.make(100), format: "webp" as const };

    it.effect("stores the source as given, with the media type of the format", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        const result = yield* store.putImage(path("img.png"), bytes("png bytes"), {
          access: "public",
          optimizeImage,
        });
        assert.strictEqual(result.contentType, "image/webp");
        assert.strictEqual(result.contentDisposition, 'inline; filename="img.png"');
        const stored = Option.getOrThrow(yield* control.blob("img.png"));
        assert.strictEqual(new TextDecoder().decode(stored.body), "png bytes");

        const sourceType = yield* store.putImage(
          path("img2"),
          new Blob([bytes("gif")], { type: "image/gif" }),
          { access: "public", optimizeImage: { width: ImageWidth.make(10) } },
        );
        assert.strictEqual(sourceType.contentType, "image/gif");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("rejects a source whose media type is not an image", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const error = yield* store
          .putImage(path("img.png"), new Blob(["text"], { type: "text/plain" }), {
            access: "public",
            optimizeImage,
          })
          .pipe(Effect.flip);
        assert.isTrue(
          Predicate.isTagged(error, "BlobUploadRejected") &&
            Predicate.isTagged(error.reason, "ContentTypeNotAllowed"),
        );
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("fetches URL sources from this store or from served URLs", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        const original = yield* store.put(path("original.jpg"), "jpeg", { access: "public" });
        const fromStore = yield* store.putImage(path("thumb.jpg"), original.url, {
          access: "public",
          optimizeImage: { width: ImageWidth.make(10) },
        });
        assert.strictEqual(fromStore.contentType, "image/jpeg");

        yield* control.serveUrl("https://images.example.com/cat.avif", "avif", "image/avif");
        const remote = yield* store.putImage(
          path("cat"),
          new URL("https://images.example.com/cat.avif"),
          { access: "public", optimizeImage: { width: ImageWidth.make(10) } },
        );
        assert.strictEqual(remote.contentType, "image/avif");
        const stored = Option.getOrThrow(yield* control.blob("cat"));
        assert.strictEqual(new TextDecoder().decode(stored.body), "avif");

        const unserved = yield* store
          .putImage(path("dog"), new URL("https://images.example.com/dog.png"), {
            access: "public",
            optimizeImage,
          })
          .pipe(Effect.flip);
        assert.isTrue(Option.isSome(badRequestMessage(unserved)));
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );
  });

  describe("multipart", () => {
    it.effect("assembles manually uploaded parts in part-number order", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const upload = yield* store.createMultipartUpload(path("video.mp4"), {
          access: "public",
          cacheControlMaxAge: "2 hours",
        });
        assert.strictEqual(upload.pathname, "video.mp4");
        assert.match(upload.key, /^video-[A-Za-z0-9]{30}\.mp4$/, "suffixed by default");
        const second = yield* store.uploadPart(upload, PartNumber.make(2), "world");
        const first = yield* store.uploadPart(
          upload,
          PartNumber.make(1),
          Stream.make(bytes("hello "), bytes("big ")),
        );
        const result = yield* store.completeMultipartUpload(upload, [second, first]);
        assert.strictEqual(result.pathname, upload.key);
        assert.strictEqual(result.contentType, "video/mp4");
        const head = yield* store.head(result.url);
        assert.strictEqual(head.cacheControl, "public, max-age=7200");
        const found = yield* store.get(result.url, { access: "public" });
        assert.strictEqual(yield* foundText(found), "hello big world");

        const reused = yield* store.uploadPart(upload, PartNumber.make(1), "x").pipe(
          Effect.flatMap(() => Effect.die("expected VercelApiError")),
          Effect.catchTag("VercelApiError", (error) => Effect.succeed(error.errorCode)),
        );
        assert.deepStrictEqual(reused, Option.some("not_found"));
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("re-uploading a part replaces it, and stale part ETags are refused", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const upload = yield* store.createMultipartUpload(path("doc.txt"), {
          access: "public",
          addRandomSuffix: false,
        });
        assert.strictEqual(upload.key, "doc.txt");
        const stale = yield* store.uploadPart(upload, PartNumber.make(1), "old");
        const fresh = yield* store.uploadPart(upload, PartNumber.make(1), "new");
        const refused = yield* store.completeMultipartUpload(upload, [stale]).pipe(Effect.flip);
        assert.isTrue(Option.isSome(badRequestMessage(refused)));
        const result = yield* store.completeMultipartUpload(upload, [fresh]);
        assert.strictEqual(result.pathname, "doc.txt");
        assert.strictEqual((yield* store.head("doc.txt")).size, 3);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("applies the overwrite rules at creation and completion", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const existing = yield* putText("doc.txt", "v1");
        const refused = yield* store
          .createMultipartUpload(path("doc.txt"), { access: "public", addRandomSuffix: false })
          .pipe(Effect.flip);
        assert.isTrue(Option.isSome(badRequestMessage(refused)));

        const conditional = yield* store.createMultipartUpload(path("doc.txt"), {
          access: "public",
          addRandomSuffix: false,
          ifMatch: existing.etag,
        });
        assert.strictEqual(conditional.allowOverwrite, true);
        const part = yield* store.uploadPart(conditional, PartNumber.make(1), "v2");
        yield* store.put(path("doc.txt"), "concurrent", { access: "public", allowOverwrite: true });
        const lost = yield* store.completeMultipartUpload(conditional, [part]).pipe(Effect.flip);
        assert.strictEqual(lost._tag, "BlobPreconditionFailed");
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );
  });

  describe("controls", () => {
    it.effect("fails the next call of an operation with a scripted error and records calls", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        const outage = new VercelApiError({
          operation: "BlobStore.put",
          errorCode: Option.some("service_unavailable"),
          reason: new ApiServerError({ message: "unavailable", status: 503 }),
        });
        yield* control.failNext("put", outage);
        const failed = yield* putText("a.txt", "a").pipe(Effect.flip);
        assert.strictEqual(failed, outage);
        assert.isTrue(Option.isNone(yield* control.blob("a.txt")));
        yield* putText("a.txt", "a");
        yield* TestClock.adjust("1 second");
        yield* store.head("a.txt");

        const calls = yield* control.calls;
        assert.deepStrictEqual(
          calls.map((entry) => [entry.operation, entry.at, entry.pathname ?? entry.locators]),
          [
            ["put", 0, "a.txt"],
            ["put", 0, "a.txt"],
            ["head", 1000, ["a.txt"]],
          ],
        );
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("seeds blobs that the store serves like written ones", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const control = yield* TestBlobStore;
        const seeded = yield* control.seed("seed/logo.svg", "<svg/>", { access: "private" });
        assert.strictEqual(seeded.contentType, "image/svg+xml");
        assert.strictEqual(seeded.cacheControl, "public, max-age=2592000");
        const head = yield* store.head(seeded.url);
        assert.strictEqual(head.etag, seeded.etag);
        assert.deepStrictEqual(yield* control.calls, [
          { operation: "head", at: 0, locators: [seeded.url.href] },
        ]);
      }).pipe(Effect.provide(TestBlobStore.layer)),
    );

    it.effect("uses the configured store id in URLs", () =>
      Effect.gen(function* () {
        const result = yield* putText("a.txt", "a");
        assert.strictEqual(result.url.href, "https://mystore.public.blob.vercel-storage.com/a.txt");
        assert.strictEqual((yield* BlobStore.use((store) => store.head(result.url))).size, 1);
      }).pipe(Effect.provide(TestBlobStore.layerWith({ storeId: StoreId.make("mystore") }))),
    );

    it.effect("gives every layer build its own store", () =>
      Effect.gen(function* () {
        yield* putText("a.txt", "a").pipe(Effect.provide(TestBlobStore.layer));
        const blobs = yield* TestBlobStore.use((control) => control.blobs).pipe(
          Effect.provide(TestBlobStore.layer),
        );
        assert.deepStrictEqual(blobs, []);
      }),
    );
  });
});
