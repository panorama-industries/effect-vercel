import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";

import {
  boundaryFromContentType,
  decodeMultipartMixed,
  encodeMultipartMixed,
} from "./multipart.ts";

const text = (value: string) => new TextEncoder().encode(value);

const decode = (body: Uint8Array | string, chunkSize = Number.MAX_SAFE_INTEGER) => {
  const bytes = typeof body === "string" ? text(body) : body;
  const chunks = Array.from({ length: Math.max(1, Math.ceil(bytes.length / chunkSize)) }, (_, i) =>
    bytes.slice(i * chunkSize, (i + 1) * chunkSize),
  );
  return Stream.fromIterable(chunks).pipe(decodeMultipartMixed("b"), Stream.runCollect);
};

const encoded = encodeMultipartMixed("b", [
  {
    headers: [
      ["content-type", "text/plain"],
      ["vqs-message-id", "m1"],
    ],
    body: text("one\r\n-"),
  },
  { headers: [["vqs-message-id", "m2"]], body: new Uint8Array([0, 13, 10, 45, 45, 255]) },
]);

describe("multipart/mixed", () => {
  it("encodes parts with CRLF framing and a closing delimiter", () => {
    assert.strictEqual(
      new TextDecoder().decode(
        encodeMultipartMixed("b", [{ headers: [["a", "1"]], body: text("x") }]),
      ),
      "--b\r\na: 1\r\n\r\nx\r\n--b--\r\n",
    );
  });

  it.effect("decodes what it encodes, however the body is chunked", () =>
    Effect.gen(function* () {
      for (const chunkSize of [1, 2, 3, 5, 8, 13, 1000]) {
        const parts = yield* decode(encoded, chunkSize);
        assert.deepStrictEqual(
          parts.map((part) => part.headers),
          [{ "content-type": "text/plain", "vqs-message-id": "m1" }, { "vqs-message-id": "m2" }],
        );
        assert.deepStrictEqual(parts[0]?.body, text("one\r\n-"));
        assert.deepStrictEqual(parts[1]?.body, new Uint8Array([0, 13, 10, 45, 45, 255]));
      }
    }),
  );

  it.effect("accepts LF line endings, empty headers and joins repeated headers", () =>
    Effect.gen(function* () {
      const parts = yield* decode("--b\nA: 1\na: 2\nbad line\n\nx\r\n--b\r\n\r\ny\r\n--b--");
      assert.deepStrictEqual(parts[0]?.headers, { a: "1, 2" });
      assert.deepStrictEqual(parts[0]?.body, text("x"));
      assert.deepStrictEqual(parts[1]?.headers, {});
      assert.deepStrictEqual(parts[1]?.body, text("y"));
    }),
  );

  it.effect("decodes an empty multipart body", () =>
    Effect.map(decode("--b--\r\n"), (parts) => assert.deepStrictEqual(parts, [])),
  );

  it.effect("fails on a missing opening boundary, bad framing or a truncated body", () =>
    Effect.gen(function* () {
      for (const body of ["", "preamble\r\n--b\r\n\r\nx\r\n--b--", "--bX", "--b\r\n\r\nx", "--b"]) {
        const error = yield* Effect.flip(decode(body));
        assert.strictEqual(error._tag, "MultipartMixedError");
      }
    }),
  );

  it("reads quoted and bare boundaries", () => {
    assert.deepStrictEqual(
      boundaryFromContentType('multipart/mixed; boundary="a b"'),
      Option.some("a b"),
    );
    assert.deepStrictEqual(
      boundaryFromContentType("multipart/mixed; BOUNDARY=x;y=1"),
      Option.some("x"),
    );
    assert.deepStrictEqual(boundaryFromContentType("multipart/mixed"), Option.none());
  });
});
