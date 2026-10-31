import { assert, describe, it } from "@effect/vitest";
import { Duration } from "effect";

import {
  allowedWriteOptions,
  cacheControlMaxAgeSeconds,
  copyWriteHeaders,
  writeHeaders,
} from "./write-headers.ts";

describe("writeHeaders", () => {
  it("always sends the access mode", () => {
    assert.deepStrictEqual(writeHeaders([], { access: "private", contentType: "text/plain" }), {
      "x-vercel-blob-access": "private",
    });
  });

  it("sends every allowed option that is set", () => {
    assert.deepStrictEqual(
      writeHeaders(allowedWriteOptions.put, {
        access: "public",
        addRandomSuffix: true,
        allowOverwrite: false,
        contentType: "image/png",
        cacheControlMaxAge: Duration.minutes(2),
      }),
      {
        "x-vercel-blob-access": "public",
        "x-add-random-suffix": "1",
        "x-allow-overwrite": "0",
        "x-content-type": "image/png",
        "x-cache-control-max-age": "120",
      },
    );
  });

  it("sends false booleans as 0 and omits unset options", () => {
    assert.deepStrictEqual(
      writeHeaders(allowedWriteOptions.put, { access: "public", addRandomSuffix: false }),
      {
        "x-vercel-blob-access": "public",
        "x-add-random-suffix": "0",
      },
    );
  });

  it("does not send an empty content type", () => {
    assert.deepStrictEqual(
      writeHeaders(allowedWriteOptions.put, { access: "public", contentType: "" }),
      {
        "x-vercel-blob-access": "public",
      },
    );
  });

  it("implies x-allow-overwrite: 1 with ifMatch unless allowOverwrite is explicit", () => {
    assert.deepStrictEqual(
      writeHeaders(allowedWriteOptions.put, { access: "public", ifMatch: '"abc123"' }),
      {
        "x-vercel-blob-access": "public",
        "x-if-match": '"abc123"',
        "x-allow-overwrite": "1",
      },
    );
    assert.deepStrictEqual(
      writeHeaders(allowedWriteOptions.put, {
        access: "public",
        ifMatch: '"abc123"',
        allowOverwrite: true,
      }),
      { "x-vercel-blob-access": "public", "x-if-match": '"abc123"', "x-allow-overwrite": "1" },
    );
  });

  it("does not imply overwriting when allowOverwrite is not an allowed option", () => {
    assert.deepStrictEqual(writeHeaders(["ifMatch"], { access: "public", ifMatch: '"e"' }), {
      "x-vercel-blob-access": "public",
      "x-if-match": '"e"',
    });
  });

  it("filters options by endpoint", () => {
    const options = {
      access: "public",
      addRandomSuffix: true,
      allowOverwrite: true,
      contentType: "text/plain",
      cacheControlMaxAge: Duration.hours(1),
      ifMatch: '"e"',
    } as const;
    assert.deepStrictEqual(writeHeaders(allowedWriteOptions.client, options), {
      "x-vercel-blob-access": "public",
      "x-content-type": "text/plain",
    });
    assert.notProperty(writeHeaders(allowedWriteOptions.multipartPart, options), "x-if-match");
    assert.notProperty(writeHeaders(allowedWriteOptions.putImage, options), "x-content-type");
    assert.propertyVal(writeHeaders(allowedWriteOptions.putImage, options), "x-if-match", '"e"');
  });
});

describe("cacheControlMaxAgeSeconds", () => {
  it("truncates to whole seconds", () => {
    assert.strictEqual(cacheControlMaxAgeSeconds(Duration.millis(61_900)), 61);
    assert.strictEqual(cacheControlMaxAgeSeconds("30 days"), 2_592_000);
  });
});

describe("copyWriteHeaders", () => {
  it("sends every option that is set, without implying overwrite for ifMatch", () => {
    assert.deepStrictEqual(
      copyWriteHeaders({
        access: "private",
        addRandomSuffix: false,
        contentType: "text/plain",
        cacheControlMaxAge: Duration.seconds(60),
        ifMatch: '"source-etag"',
      }),
      {
        "x-vercel-blob-access": "private",
        "x-add-random-suffix": "0",
        "x-content-type": "text/plain",
        "x-cache-control-max-age": "60",
        "x-if-match": '"source-etag"',
      },
    );
  });
});
