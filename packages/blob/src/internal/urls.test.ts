import { assert, describe, it } from "@effect/vitest";

import { StoreId } from "../contracts/blob-domain.ts";
import { blobUrl, defaultBlobBaseUrl, downloadUrl, isAllowedBlobUrl, isUrl } from "./urls.ts";

const production = new URL("https://vercel.com/api/blob");
const emulator = new URL("http://localhost:3000/api/blob");

describe("blob URLs", () => {
  it("builds the default store host", () => {
    assert.strictEqual(
      blobUrl(defaultBlobBaseUrl(StoreId.make("AbC"), "private"), "folder/a b.txt").href,
      "https://abc.private.blob.vercel-storage.com/folder/a%20b.txt",
    );
    assert.strictEqual(
      blobUrl(new URL("http://127.0.0.1:4000/store"), "x.txt").href,
      "http://127.0.0.1:4000/store/x.txt",
    );
  });

  it("detects URLs like the SDK", () => {
    assert.isTrue(isUrl("https://a.public.blob.vercel-storage.com/x"));
    assert.isTrue(isUrl("http://localhost/x"));
    assert.isFalse(isUrl("folder/x.txt"));
  });

  it("allows blob hosts, and the API origin only when it is overridden", () => {
    assert.isTrue(
      isAllowedBlobUrl(new URL("https://s.public.blob.vercel-storage.com/a"), production),
    );
    assert.isFalse(isAllowedBlobUrl(new URL("https://example.com/a"), production));
    assert.isFalse(isAllowedBlobUrl(new URL("https://vercel.com/a"), production));
    assert.isTrue(isAllowedBlobUrl(new URL("http://localhost:3000/store/a"), emulator));
    assert.isFalse(isAllowedBlobUrl(new URL("http://localhost:3001/a"), emulator));
  });

  it("adds download=1 to make a download URL", () => {
    assert.strictEqual(
      downloadUrl("https://s.public.blob.vercel-storage.com/a.txt").href,
      "https://s.public.blob.vercel-storage.com/a.txt?download=1",
    );
    assert.strictEqual(
      downloadUrl(new URL("https://s.public.blob.vercel-storage.com/a.txt?v=2")).href,
      "https://s.public.blob.vercel-storage.com/a.txt?v=2&download=1",
    );
  });
});
