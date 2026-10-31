import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { Base64Url } from "effect/encoding";

import {
  normalizeStoreId,
  parseStoreId,
  storeIdFromClientToken,
  storeIdFromDelegationToken,
  storeIdFromReadWriteToken,
} from "./store-id.ts";

const delegation = (payload: unknown) =>
  `${Base64Url.encode(JSON.stringify(payload))}.${Base64Url.encode("signature")}`;

describe("store ids", () => {
  it("strips the store_ prefix and keeps the case", () => {
    assert.strictEqual(normalizeStoreId("store_WdsHBk1w9fDO4vPW"), "WdsHBk1w9fDO4vPW");
    assert.strictEqual(normalizeStoreId("AbCDef"), "AbCDef");
    assert.deepStrictEqual(parseStoreId("store_AbCDef"), Option.some("AbCDef"));
    assert.isTrue(Option.isNone(parseStoreId("")));
    assert.isTrue(Option.isNone(parseStoreId("store_")));
    assert.isTrue(Option.isNone(parseStoreId("has space")));
  });

  it("reads the store id from read-write and client tokens", () => {
    assert.deepStrictEqual(
      storeIdFromReadWriteToken("vercel_blob_rw_fallbackStore_30FakeRandomCharacters12345678"),
      Option.some("fallbackStore"),
    );
    assert.deepStrictEqual(
      storeIdFromClientToken("vercel_blob_client_clientStore_ZmFrZQ=="),
      Option.some("clientStore"),
    );
    assert.isTrue(Option.isNone(storeIdFromReadWriteToken("123")));
    assert.isTrue(Option.isNone(storeIdFromReadWriteToken("vercel_blob_rw__secret")));
  });

  it("reads the store id from a delegation token payload", () => {
    assert.deepStrictEqual(
      storeIdFromDelegationToken(delegation({ storeId: "store_AbC", pathname: "*" })),
      Option.some("AbC"),
    );
    assert.deepStrictEqual(
      storeIdFromDelegationToken(delegation({ storeId: "plainId" })),
      Option.some("plainId"),
    );
  });

  it("accepts a padded or standard base64 payload segment, like atob", () => {
    const json = JSON.stringify({ storeId: "abc", note: "??>>" });
    const standard = btoa(json);
    assert.match(standard, /[+/=]/);
    assert.deepStrictEqual(storeIdFromDelegationToken(`${standard}.sig`), Option.some("abc"));
  });

  it("returns none for malformed delegation tokens", () => {
    assert.isTrue(Option.isNone(storeIdFromDelegationToken("no-dot")));
    assert.isTrue(Option.isNone(storeIdFromDelegationToken("!!!.sig")));
    assert.isTrue(Option.isNone(storeIdFromDelegationToken(`${Base64Url.encode("not json")}.s`)));
    assert.isTrue(Option.isNone(storeIdFromDelegationToken(delegation({ other: 1 }))));
    assert.isTrue(Option.isNone(storeIdFromDelegationToken(delegation({ storeId: "" }))));
    assert.isTrue(Option.isNone(storeIdFromDelegationToken(delegation({ storeId: 42 }))));
  });
});
