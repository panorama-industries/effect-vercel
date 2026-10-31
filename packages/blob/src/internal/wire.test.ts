import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Schema } from "effect";

import { BlobMetadata, ListPage, PutBlobResult } from "../contracts/blob-domain.ts";
import { HeadBlobResponse, ListResponse, PutBlobResponse } from "./wire.ts";

const putJson = {
  url: "https://s.public.blob.vercel-storage.com/a.txt",
  downloadUrl: "https://s.public.blob.vercel-storage.com/a.txt?download=1",
  pathname: "a.txt",
  contentType: "text/plain",
  contentDisposition: 'inline; filename="a.txt"',
  etag: '"e1"',
  extra: "ignored",
};

const listed = {
  url: putJson.url,
  downloadUrl: putJson.downloadUrl,
  pathname: "a.txt",
  size: 3,
  uploadedAt: "2024-01-02T03:04:05.000Z",
  etag: '"e1"',
};

describe("wire schemas", () => {
  it.effect("decodes a put response into PutBlobResult", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(PutBlobResponse)(putJson);
      assert.instanceOf(result, PutBlobResult);
      assert.instanceOf(result.url, URL);
      assert.strictEqual(result.downloadUrl.searchParams.get("download"), "1");
      assert.strictEqual(result.etag, '"e1"');
    }),
  );

  it.effect("decodes a head response with uploadedAt as DateTime.Utc", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(HeadBlobResponse)({
        ...listed,
        contentType: "text/plain",
        contentDisposition: "inline",
        cacheControl: "public, max-age=60",
      });
      assert.instanceOf(result, BlobMetadata);
      assert.isTrue(DateTime.isDateTime(result.uploadedAt));
      assert.strictEqual(DateTime.formatIso(result.uploadedAt), "2024-01-02T03:04:05.000Z");
    }),
  );

  it.effect("decodes list pages with and without folders and cursor", () =>
    Effect.gen(function* () {
      const expanded = yield* Schema.decodeUnknownEffect(ListResponse)({
        blobs: [listed],
        hasMore: false,
      });
      assert.instanceOf(expanded, ListPage);
      assert.deepStrictEqual(expanded.folders, []);
      assert.isTrue(Option.isNone(expanded.cursor));
      assert.strictEqual(expanded.blobs[0]?.size, 3);

      const folded = yield* Schema.decodeUnknownEffect(ListResponse)({
        blobs: [],
        folders: ["a/", "b/"],
        cursor: "next",
        hasMore: true,
      });
      assert.deepStrictEqual(folded.folders, ["a/", "b/"]);
      assert.deepStrictEqual(folded.cursor, Option.some("next"));
    }),
  );

  it.effect("rejects malformed responses", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(PutBlobResponse)({ ...putJson, url: "not a url" }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
