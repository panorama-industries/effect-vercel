import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { createHmac } from "node:crypto";

import { StoreId } from "../contracts/blob-domain.ts";
import {
  clientTokenPayloadJson,
  contradictsIfMatch,
  getPayloadFromClientToken,
  hmacSha256Hex,
  signClientToken,
} from "./client-token.ts";

const rwToken = "vercel_blob_rw_12345fakeStoreId_30FakeRandomCharacters12345678";
const storeId = StoreId.make("12345fakeStoreId");

/** 2023-01-01T00:00:00Z, the SDK tests' fake clock. */
const now = Date.parse("2023-01-01");

// Golden tokens from the SDK's client.node.test.ts / client.edge.test.ts.
const fooToken =
  "vercel_blob_client_12345fakeStoreId_ZTVmZTJmYWZkOWJhMGNiNTVjOGExOWJkM2VhY2M5NzRhNzM4MmQ2NmEyN2EyMmYwMzFkMjQ0ZDIyMjMzN2Y0Yy5leUp3WVhSb2JtRnRaU0k2SW1admJ5NTBlSFFpTENKdmJsVndiRzloWkVOdmJYQnNaWFJsWkNJNmV5SmpZV3hzWW1GamExVnliQ0k2SW1oMGRIQnpPaTh2WlhoaGJYQnNaUzVqYjIwaWZTd2lkbUZzYVdSVmJuUnBiQ0k2TVRZM01qVXpNVEl6TURBd01IMD0=";
const fooWithTokenPayloadToken =
  "vercel_blob_client_12345fakeStoreId_N2I2NTAxOGI1Y2IwZDhlY2VlZGUyYTQ2YjE1ZmJhODRlYjU3M2Q5MjBlNjNiYmI4NmQ0ZTRhOTJhZmM1NTVjMi5leUp3WVhSb2JtRnRaU0k2SW1admJ5NTBlSFFpTENKdmJsVndiRzloWkVOdmJYQnNaWFJsWkNJNmV5SmpZV3hzWW1GamExVnliQ0k2SW1oMGRIQnpPaTh2WlhoaGJYQnNaUzVqYjIwaUxDSjBiMnRsYmxCaGVXeHZZV1FpT2lKN1hDSm1iMjljSWpwY0ltSmhjbHdpZlNKOUxDSjJZV3hwWkZWdWRHbHNJam94TmpjeU5UTXhNak13TURBd2ZRPT0=";

describe("clientTokenPayloadJson", () => {
  it("keeps the caller's key order and appends validUntil", () => {
    assert.strictEqual(
      clientTokenPayloadJson(
        { pathname: "foo.txt", onUploadCompleted: { callbackUrl: "https://example.com" } },
        now + 30_000,
      ),
      '{"pathname":"foo.txt","onUploadCompleted":{"callbackUrl":"https://example.com"},"validUntil":1672531230000}',
    );
  });

  it("keeps a given validUntil in place", () => {
    assert.strictEqual(
      clientTokenPayloadJson({ validUntil: 5, pathname: "a" }, 1),
      '{"validUntil":5,"pathname":"a"}',
    );
  });

  it("appends allowOverwrite: true for ifMatch without allowOverwrite", () => {
    assert.strictEqual(
      clientTokenPayloadJson({ pathname: "a", ifMatch: '"abc123"' }, 1),
      '{"pathname":"a","ifMatch":"\\"abc123\\"","allowOverwrite":true,"validUntil":1}',
    );
    assert.strictEqual(
      clientTokenPayloadJson({ pathname: "a", allowOverwrite: undefined, ifMatch: "x" }, 1),
      '{"pathname":"a","allowOverwrite":true,"ifMatch":"x","validUntil":1}',
    );
  });

  it("omits undefined fields and keeps null ones", () => {
    assert.strictEqual(
      clientTokenPayloadJson(
        {
          pathname: "a",
          addRandomSuffix: undefined,
          onUploadCompleted: { callbackUrl: "https://e.com", tokenPayload: null },
        },
        1,
      ),
      '{"pathname":"a","onUploadCompleted":{"callbackUrl":"https://e.com","tokenPayload":null},"validUntil":1}',
    );
  });
});

describe("contradictsIfMatch", () => {
  it("is true only for ifMatch with allowOverwrite: false", () => {
    assert.isTrue(contradictsIfMatch({ ifMatch: "x", allowOverwrite: false }));
    assert.isFalse(contradictsIfMatch({ ifMatch: "x", allowOverwrite: true }));
    assert.isFalse(contradictsIfMatch({ ifMatch: "x" }));
    assert.isFalse(contradictsIfMatch({ allowOverwrite: false }));
  });
});

describe("signClientToken", () => {
  it.effect("generates the SDK's golden client token", () =>
    Effect.gen(function* () {
      const token = yield* signClientToken(
        rwToken,
        storeId,
        clientTokenPayloadJson(
          { pathname: "foo.txt", onUploadCompleted: { callbackUrl: "https://example.com" } },
          now + 30_000,
        ),
      );
      assert.strictEqual(token, fooToken);
    }),
  );

  it.effect("generates the SDK's golden token with a tokenPayload", () =>
    Effect.gen(function* () {
      const token = yield* signClientToken(
        rwToken,
        storeId,
        clientTokenPayloadJson(
          {
            pathname: "foo.txt",
            onUploadCompleted: {
              callbackUrl: "https://example.com",
              tokenPayload: JSON.stringify({ foo: "bar" }),
            },
          },
          now + 30_000,
        ),
      );
      assert.strictEqual(token, fooWithTokenPayloadToken);
    }),
  );
});

describe("hmacSha256Hex", () => {
  it.effect("matches node:crypto", () =>
    Effect.gen(function* () {
      const signature = yield* hmacSha256Hex("secret", "payload ✓");
      assert.strictEqual(
        signature,
        createHmac("sha256", "secret").update("payload ✓").digest("hex"),
      );
    }),
  );
});

describe("getPayloadFromClientToken", () => {
  it("decodes the SDK's golden tokens", () => {
    assert.deepStrictEqual(
      getPayloadFromClientToken(fooToken),
      Option.some({
        pathname: "foo.txt",
        onUploadCompleted: { callbackUrl: "https://example.com" },
        validUntil: 1672531230000,
      }),
    );
    assert.deepStrictEqual(
      getPayloadFromClientToken(fooWithTokenPayloadToken),
      Option.some({
        pathname: "foo.txt",
        onUploadCompleted: { callbackUrl: "https://example.com", tokenPayload: '{"foo":"bar"}' },
        validUntil: 1672531230000,
      }),
    );
  });

  it("is none for tokens without a payload", () => {
    assert.isTrue(Option.isNone(getPayloadFromClientToken("vercel_blob_client_store_")));
    assert.isTrue(Option.isNone(getPayloadFromClientToken("vercel_blob_client_store_bm9wZQ==")));
    assert.isTrue(Option.isNone(getPayloadFromClientToken("not a token")));
  });
});
