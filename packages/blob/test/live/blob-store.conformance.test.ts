/**
 * Conformance of `TestBlobStore` with real Vercel Blob stores: each scenario runs once against a
 * live store through `BlobStoreLive` and once against a fresh `TestBlobStore`, with the same
 * pathnames, and the normalized outcomes must be equal.
 *
 * Run with `pnpm test:live`. Each store needs its read-write token in `.env` or the environment:
 * `BLOB_READ_WRITE_TOKEN_PRIVATE` for a store created with private access and
 * `BLOB_READ_WRITE_TOKEN_PUBLIC` for one with public access. Blobs are written under a prefix
 * unique to the run and deleted afterwards.
 */
import { afterAll, assert, describe, it } from "@effect/vitest";
import { vercelOidcFromToken } from "@panorama-industries/effect-vercel-core";
import { Array, Cause, Duration, Effect, Layer, Option, Predicate, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import type { BlobAccess, BlobMetadata, PutBlobResult } from "../../src/contracts/blob-domain.ts";

import { BlobPathname, ETag } from "../../src/contracts/blob-domain.ts";
import { BlobStore } from "../../src/contracts/blob-store.ts";
import { blobConfigLayer } from "../../src/implementation/blob-config-live.ts";
import { BlobStoreLive } from "../../src/implementation/blob-store-live.ts";
import { TestBlobStore } from "../../src/testing/test-blob-store.ts";

const runPrefix = `conformance/${randomUUID()}`;

const liveLayer = (token: string) =>
  BlobStoreLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        blobConfigLayer({ token, retries: 2 }),
        FetchHttpClient.layer,
        vercelOidcFromToken(Redacted.make("unused")),
      ),
    ),
  );

type Store = BlobStore["Service"];

/** A scenario receives the store and turns a name into a pathname under its own prefix. */
type Scenario = (
  store: Store,
  path: (name: string) => BlobPathname,
  access: BlobAccess,
) => Effect.Effect<unknown, unknown>;

const describeFailure = (error: unknown): unknown => {
  if (!Predicate.hasProperty(error, "_tag")) return { defect: String(error) };
  const described: Record<string, unknown> = { _tag: error._tag };
  if (Predicate.hasProperty(error, "errorCode") && Option.isOption(error.errorCode)) {
    described.errorCode = Option.getOrUndefined(error.errorCode);
  }
  const reason = Predicate.hasProperty(error, "reason") ? error.reason : undefined;
  if (Predicate.hasProperty(reason, "_tag")) {
    described.reason = reason._tag;
    if (Predicate.hasProperty(reason, "message")) described.message = reason.message;
    if (Predicate.hasProperty(reason, "status")) described.status = reason.status;
  } else if (Predicate.hasProperty(error, "message")) {
    described.message = error.message;
  }
  return described;
};

/** Success as `{ ok }`, a typed failure as `{ error }`, a defect as `{ defect }`. */
const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.map((ok): unknown => ({ ok })),
    Effect.catch((error) => Effect.succeed({ error: describeFailure(error) })),
    Effect.catchCause((cause) => Effect.succeed({ defect: String(Cause.squash(cause)) })),
  );

const served = (blob: PutBlobResult | BlobMetadata) => ({
  contentType: blob.contentType,
  contentDisposition: blob.contentDisposition,
});

const scenarios: Record<string, Scenario> = {};

const stale = ETag.make('"0000000000000000"');

// Writing over an existing blob ----------------------------------------------------------------

scenarios["put over an existing blob without allowOverwrite"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "first", { access });
    return yield* outcome(store.put(path("a.txt"), "second", { access }));
  });

scenarios["put over an existing blob with allowOverwrite: false"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "first", { access });
    return yield* outcome(store.put(path("a.txt"), "second", { access, allowOverwrite: false }));
  });

scenarios["copy over an existing blob without allowOverwrite"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "a", { access });
    yield* store.put(path("b.txt"), "b", { access });
    return yield* outcome(Effect.map(store.copy(path("a.txt"), path("b.txt"), { access }), served));
  });

scenarios["copy over an existing blob with allowOverwrite: false"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "a", { access });
    yield* store.put(path("b.txt"), "b", { access });
    return yield* outcome(
      Effect.map(
        store.copy(path("a.txt"), path("b.txt"), { access, allowOverwrite: false }),
        served,
      ),
    );
  });

scenarios["rename over an existing blob without allowOverwrite"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "a", { access });
    yield* store.put(path("b.txt"), "b", { access });
    const renamed = yield* outcome(
      Effect.map(store.rename(path("a.txt"), path("b.txt"), { access }), served),
    );
    const source = yield* outcome(Effect.map(store.head(path("a.txt")), served));
    return { renamed, source };
  });

scenarios["multipart put over an existing blob without allowOverwrite"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "a", { access });
    return yield* outcome(
      Effect.map(store.put(path("a.txt"), "b", { access, multipart: true }), served),
    );
  });

scenarios["createFolder over an existing folder"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.createFolder(path("folder"), { access });
    return yield* outcome(
      Effect.map(store.createFolder(path("folder"), { access }), (f) => f.pathname.endsWith("/")),
    );
  });

scenarios["multipart put of a string to a pathname without extension"] = (store, path, access) =>
  Effect.gen(function* () {
    const put = yield* store.put(path("no-extension"), "x", { access, multipart: true });
    return served(yield* store.head(put.pathname));
  });

scenarios["copy to a pathname without extension"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("source.png"), "x", { access });
    const copy = yield* store.copy(path("source.png"), path("copy"), { access });
    return served(yield* store.head(copy.pathname));
  });

scenarios["createFolder without access"] = (store, path) =>
  outcome(
    Effect.map(store.createFolder(path("folder")), (folder) => folder.pathname.endsWith("/")),
  );

scenarios["copy with the other access than the store's"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "x", { access });
    return yield* outcome(
      Effect.map(
        store.copy(path("a.txt"), path("b.txt"), {
          access: access === "public" ? "private" : "public",
        }),
        served,
      ),
    );
  });

scenarios["put with ifMatch on a missing blob through multipart"] = (store, path, access) =>
  outcome(store.put(path("missing.txt"), "x", { access, multipart: true, ifMatch: stale }));

scenarios["rename from a missing blob"] = (store, path, access) =>
  outcome(store.rename(path("missing.txt"), path("renamed.txt"), { access }));

// Missing blobs ----------------------------------------------------------------------------------

scenarios["head of a missing blob"] = (store, path) => outcome(store.head(path("missing.txt")));

scenarios["del of a missing blob"] = (store, path) => outcome(store.del(path("missing.txt")));

scenarios["copy from a missing blob"] = (store, path, access) =>
  outcome(store.copy(path("missing.txt"), path("copy.txt"), { access }));

scenarios["get of a missing blob"] = (store, path, access) =>
  outcome(Effect.map(store.get(path("missing.txt"), { access }), (result) => result._tag));

// contentDisposition and contentType ------------------------------------------------------------

const dispositionCases: ReadonlyArray<readonly [name: string, contentType?: string]> = [
  ["image.png"],
  ["image.jpg"],
  ["image.gif"],
  ["image.webp"],
  ["image.avif"],
  ["image.svg"],
  ["image.ico"],
  ["video.mp4"],
  ["video.webm"],
  ["audio.mp3"],
  ["audio.wav"],
  ["document.pdf"],
  ["text.txt"],
  ["text.md"],
  ["text.csv"],
  ["data.json"],
  ["page.html"],
  ["style.css"],
  ["script.js"],
  ["archive.zip"],
  ["binary.bin"],
  ["no-extension"],
  ["UPPER.PNG"],
  ["name with spaces.txt"],
  ["ünïcødé.txt"],
  ['quote".txt'],
  ["text-as-image.txt", "image/png"],
  ["image-as-text.png", "text/plain"],
  ["html-explicit", "text/html"],
  ["svg-explicit", "image/svg+xml"],
  ["pdf-explicit", "application/pdf"],
  ["with-charset.txt", "text/plain; charset=utf-8"],
  ["upper-case-type", "TEXT/PLAIN"],
  ["json-charset", "application/json; charset=utf-8"],
  ["png-param", "image/png; foo=bar"],
  ["pdf-param", "application/pdf; foo=bar"],
  ["audio-param", "audio/mpeg; foo=bar"],
  ["xml-explicit", "text/xml"],
  ["app-xml-explicit", "application/xml"],
  ["ld-json-explicit", "application/ld+json"],
  ["octet-explicit", "application/octet-stream"],
  ["image-unknown", "image/x-custom"],
  ["text-unknown", "text/x-custom"],
  ["font.woff2"],
  ["data.xml"],
  ["page.htm"],
  ["module.mjs"],
  ["image.jpeg"],
  ["image.tiff"],
  ["image.bmp"],
  ["image.heic"],
  ["video.mov"],
  ["audio.ogg"],
  ["audio.m4a"],
  ["data.yaml"],
  ["data.wasm"],
  ["data.gz"],
  ["sheet.xlsx"],
  ["tab\tname.txt"],
  ["percent%41.txt"],
  ["semi;colon.txt"],
  ["back\\slash.txt"],
  ["folder/nested.txt"],
  ["audio.aac"],
  ["audio.oga"],
  ["video.ogv"],
  ["font.otf"],
  ["font.ttf"],
  ["archive.tar"],
  ["image.tif"],
  ["data.yml"],
  ["upper-image-type", "IMAGE/PNG"],
];

for (const [name, contentType] of dispositionCases) {
  scenarios[`disposition of ${name}${contentType === undefined ? "" : ` as ${contentType}`}`] = (
    store,
    path,
    access,
  ) =>
    Effect.gen(function* () {
      const put = yield* store.put(path(name), "x", {
        access,
        ...(contentType === undefined ? {} : { contentType }),
      });
      const head = yield* store.head(put.pathname);
      return { put: served(put), head: served(head) };
    });
}

const bodyCases: ReadonlyArray<
  readonly [label: string, body: () => string | Uint8Array | globalThis.Blob]
> = [
  ["a string", () => "x"],
  ["bytes", () => new Uint8Array([1, 2, 3])],
  ["a Blob without type", () => new globalThis.Blob(["x"])],
  ["a Blob of type image/png", () => new globalThis.Blob(["x"], { type: "image/png" })],
  ["a stream", () => "stream"],
];

for (const [label, body] of bodyCases) {
  scenarios[`media type of a pathname without extension from ${label}`] = (store, path, access) =>
    Effect.gen(function* () {
      const value = body();
      const put = yield* store.put(
        path("no-extension"),
        value === "stream" ? Stream.make(new TextEncoder().encode("x")) : value,
        { access },
      );
      return served(yield* store.head(put.pathname));
    });
  scenarios[`media type of a .txt pathname from ${label}`] = (store, path, access) =>
    Effect.gen(function* () {
      const value = body();
      const put = yield* store.put(
        path("text.txt"),
        value === "stream" ? Stream.make(new TextEncoder().encode("x")) : value,
        { access },
      );
      return served(yield* store.head(put.pathname));
    });
}

// cacheControl -----------------------------------------------------------------------------------

const cacheCases: ReadonlyArray<readonly [label: string, maxAge?: Duration.Input]> = [
  ["default"],
  ["60 seconds", "60 seconds"],
  ["1 hour", "1 hour"],
  ["365 days", "365 days"],
];

for (const [label, maxAge] of cacheCases) {
  scenarios[`cacheControl with max age ${label}`] = (store, path, access) =>
    Effect.gen(function* () {
      const put = yield* store.put(path("cached.txt"), "x", {
        access,
        ...(maxAge === undefined ? {} : { cacheControlMaxAge: maxAge }),
      });
      return (yield* store.head(put.pathname)).cacheControl;
    });
}

scenarios["copy does not inherit media type or cache lifetime"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("source.txt"), "x", {
      access,
      contentType: "application/json",
      cacheControlMaxAge: "60 seconds",
    });
    const copy = yield* store.copy(path("source.txt"), path("copy.txt"), { access });
    const head = yield* store.head(copy.pathname);
    return { ...served(head), cacheControl: head.cacheControl };
  });

// ifMatch ----------------------------------------------------------------------------------------

scenarios["put with ifMatch on a missing blob"] = (store, path, access) =>
  outcome(store.put(path("missing.txt"), "x", { access, ifMatch: stale }));

scenarios["put with a stale ifMatch on an existing blob"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "x", { access });
    return yield* outcome(store.put(path("a.txt"), "y", { access, ifMatch: stale }));
  });

scenarios["put with the current ifMatch"] = (store, path, access) =>
  Effect.gen(function* () {
    const first = yield* store.put(path("a.txt"), "x", { access });
    return yield* outcome(
      Effect.map(store.put(path("a.txt"), "y", { access, ifMatch: first.etag }), served),
    );
  });

scenarios["del with ifMatch on a missing blob"] = (store, path) =>
  outcome(store.del(path("missing.txt"), { ifMatch: stale }));

scenarios["del with a stale ifMatch on an existing blob"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "x", { access });
    return yield* outcome(store.del(path("a.txt"), { ifMatch: stale }));
  });

scenarios["copy with ifMatch from a missing blob"] = (store, path, access) =>
  outcome(store.copy(path("missing.txt"), path("copy.txt"), { access, ifMatch: stale }));

scenarios["copy with a stale ifMatch from an existing blob"] = (store, path, access) =>
  Effect.gen(function* () {
    yield* store.put(path("a.txt"), "x", { access });
    return yield* outcome(store.copy(path("a.txt"), path("copy.txt"), { access, ifMatch: stale }));
  });

scenarios["copy with the source's ifMatch onto an existing destination"] = (store, path, access) =>
  Effect.gen(function* () {
    const source = yield* store.put(path("a.txt"), "x", { access });
    yield* store.put(path("copy.txt"), "y", { access });
    return yield* outcome(
      Effect.map(
        store.copy(path("a.txt"), path("copy.txt"), { access, ifMatch: source.etag }),
        served,
      ),
    );
  });

// Store access -----------------------------------------------------------------------------------

scenarios["put with the other access than the store's"] = (store, path, access) =>
  outcome(
    Effect.map(
      store.put(path("other.txt"), "x", { access: access === "public" ? "private" : "public" }),
      served,
    ),
  );

// Runner -----------------------------------------------------------------------------------------

const stores: ReadonlyArray<readonly [BlobAccess, string | undefined]> = [
  ["private", process.env.BLOB_READ_WRITE_TOKEN_PRIVATE],
  ["public", process.env.BLOB_READ_WRITE_TOKEN_PUBLIC],
];

for (const [access, token] of stores) {
  describe.skipIf(token === undefined || token === "")(
    `TestBlobStore matches a ${access} store`,
    () => {
      const live = liveLayer(token ?? "");
      const prefix = `${runPrefix}/${access}`;

      afterAll(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* BlobStore;
            const blobs = yield* Stream.runCollect(store.listAll({ prefix }));
            for (const chunk of Array.chunksOf(blobs, 100)) {
              if (Array.isArrayNonEmpty(chunk)) {
                yield* store.delMany(Array.map(chunk, (blob) => blob.url));
              }
            }
          }).pipe(Effect.provide(live)),
        ),
      );

      Object.entries(scenarios).forEach(([name, scenario], index) => {
        it.effect(name, () =>
          Effect.gen(function* () {
            const path = (file: string) => BlobPathname.make(`${prefix}/${index}/${file}`);
            const run = (layer: Layer.Layer<BlobStore, unknown>) =>
              Effect.gen(function* () {
                return yield* outcome(scenario(yield* BlobStore, path, access));
              }).pipe(Effect.provide(layer));

            const expected = yield* run(live);
            const actual = yield* run(TestBlobStore.layerWith({ access }));
            if (process.env.CONFORMANCE_LOG !== undefined) {
              appendFileSync(
                process.env.CONFORMANCE_LOG,
                `${JSON.stringify({ access, name, live: expected, test: actual })}\n`,
              );
            }
            assert.deepStrictEqual(actual, expected);
          }),
        );
      });
    },
  );
}
