import { assert, describe, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Exit, Option, Redacted } from "effect";

import type { BlobConfigOptions } from "./blob-config-live.ts";

import { BlobAuth, BlobConfig } from "../contracts/blob-config.ts";
import { StoreId } from "../contracts/blob-domain.ts";
import { BlobConfigLive, blobConfigLayer } from "./blob-config-live.ts";

const rwToken = "vercel_blob_rw_rwStore_30FakeRandomCharacters12345678";

const build = (vars: Record<string, string>, options?: BlobConfigOptions) =>
  Effect.service(BlobConfig).pipe(
    Effect.provide(options === undefined ? BlobConfigLive : blobConfigLayer(options)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars))),
  );

const failure = (vars: Record<string, string>, options?: BlobConfigOptions) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(build(vars, options));
    assert.isTrue(Exit.isFailure(exit));
    const error = yield* Effect.flip(build(vars, options));
    assert.instanceOf(error, Config.ConfigError);
    return String(error);
  });

const describeAuth = (auth: BlobAuth) =>
  BlobAuth.$match(auth, {
    Oidc: ({ storeId }) => `oidc:${storeId}`,
    ReadWrite: ({ token, storeId }) => `rw:${storeId}:${Redacted.value(token)}`,
  });

const readWrite = (config: BlobConfig["Service"]) =>
  Option.map(config.readWriteToken, Redacted.value);

describe("BlobConfigLive", () => {
  it.effect("uses BLOB_READ_WRITE_TOKEN with the defaults", () =>
    Effect.gen(function* () {
      const config = yield* build({ BLOB_READ_WRITE_TOKEN: rwToken });
      assert.strictEqual(describeAuth(config.auth), `rw:rwStore:${rwToken}`);
      assert.deepStrictEqual(readWrite(config), Option.some(rwToken));
      assert.strictEqual(config.apiUrl.href, "https://vercel.com/api/blob");
      assert.strictEqual(config.apiVersion, "13");
      assert.strictEqual(config.retries, 10);
      assert.isFalse(config.sendContentLength);
      assert.deepStrictEqual(config.headers, {});
      assert.isTrue(Option.isNone(config.webhookPublicKey));
      assert.isTrue(Option.isNone(config.callbackBaseUrl));
      assert.strictEqual(
        config.blobBaseUrl(StoreId.make("rwStore"), "public").href,
        "https://rwstore.public.blob.vercel-storage.com/",
      );
    }),
  );

  it.effect("prefers OIDC when a store id is set, keeping the read-write token as fallback", () =>
    Effect.gen(function* () {
      const config = yield* build({ BLOB_READ_WRITE_TOKEN: rwToken, BLOB_STORE_ID: "oidcStore" });
      assert.strictEqual(describeAuth(config.auth), "oidc:oidcStore");
      assert.deepStrictEqual(readWrite(config), Option.some(rwToken));
    }),
  );

  it.effect("uses OIDC with BLOB_STORE_ID alone", () =>
    Effect.gen(function* () {
      const config = yield* build({ BLOB_STORE_ID: "oidcStore" });
      assert.strictEqual(describeAuth(config.auth), "oidc:oidcStore");
      assert.isTrue(Option.isNone(config.readWriteToken));
    }),
  );

  it.effect(
    "strips the store_ prefix from BLOB_STORE_ID and the storeId option, keeping case",
    () =>
      Effect.gen(function* () {
        const fromEnv = yield* build({ BLOB_STORE_ID: "store_WdsHBk1w9fDO4vPW" });
        assert.strictEqual(describeAuth(fromEnv.auth), "oidc:WdsHBk1w9fDO4vPW");
        const fromOption = yield* build({}, { storeId: "store_AbCDef" });
        assert.strictEqual(describeAuth(fromOption.auth), "oidc:AbCDef");
      }),
  );

  it.effect("prefers the storeId option over BLOB_STORE_ID", () =>
    Effect.gen(function* () {
      const config = yield* build({ BLOB_STORE_ID: "fromEnv" }, { storeId: "fromOption" });
      assert.strictEqual(describeAuth(config.auth), "oidc:fromOption");
    }),
  );

  it.effect("prefers the token option over OIDC and the environment token", () =>
    Effect.gen(function* () {
      const token = "vercel_blob_rw_optionStore_secret";
      const config = yield* build(
        { BLOB_READ_WRITE_TOKEN: rwToken, BLOB_STORE_ID: "oidcStore" },
        { token, storeId: "other" },
      );
      assert.strictEqual(describeAuth(config.auth), `rw:optionStore:${token}`);
      assert.deepStrictEqual(readWrite(config), Option.some(token));
      const redacted = yield* build({}, { token: Redacted.make(token) });
      assert.strictEqual(describeAuth(redacted.auth), `rw:optionStore:${token}`);
    }),
  );

  it.effect("trims variables and ignores blank ones", () =>
    Effect.gen(function* () {
      const config = yield* build({
        BLOB_READ_WRITE_TOKEN: `  ${rwToken}  `,
        BLOB_STORE_ID: "   ",
        VERCEL_BLOB_API_URL: " ",
        VERCEL_BLOB_RETRIES: "",
      });
      assert.strictEqual(describeAuth(config.auth), `rw:rwStore:${rwToken}`);
      assert.strictEqual(config.apiUrl.href, "https://vercel.com/api/blob");
      assert.strictEqual(config.retries, 10);
    }),
  );

  it.effect("reads the API URL, version and proxy header, falling back to NEXT_PUBLIC_", () =>
    Effect.gen(function* () {
      const direct = yield* build({
        BLOB_READ_WRITE_TOKEN: rwToken,
        VERCEL_BLOB_API_URL: "http://localhost:3000/api/blob",
        NEXT_PUBLIC_VERCEL_BLOB_API_URL: "http://localhost:4000/api/blob",
        VERCEL_BLOB_API_VERSION_OVERRIDE: "14",
        NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE: "15",
        VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API: "a",
        NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API: "b",
      });
      assert.strictEqual(direct.apiUrl.href, "http://localhost:3000/api/blob");
      assert.strictEqual(direct.apiVersion, "14");
      assert.deepStrictEqual(direct.headers, { "x-proxy-through-alternative-api": "a" });

      const nextPublic = yield* build({
        BLOB_READ_WRITE_TOKEN: rwToken,
        NEXT_PUBLIC_VERCEL_BLOB_API_URL: "http://localhost:4000/api/blob",
        NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE: "15",
        NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API: "b",
      });
      assert.strictEqual(nextPublic.apiUrl.href, "http://localhost:4000/api/blob");
      assert.strictEqual(nextPublic.apiVersion, "15");
      assert.deepStrictEqual(nextPublic.headers, { "x-proxy-through-alternative-api": "b" });
    }),
  );

  it.effect("reads retries, x-content-length, the webhook key and the callback URL", () =>
    Effect.gen(function* () {
      const config = yield* build({
        BLOB_READ_WRITE_TOKEN: rwToken,
        VERCEL_BLOB_RETRIES: "0",
        VERCEL_BLOB_USE_X_CONTENT_LENGTH: "1",
        BLOB_WEBHOOK_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----",
        VERCEL_BLOB_CALLBACK_URL: "https://tunnel.example.com",
      });
      assert.strictEqual(config.retries, 0);
      assert.isTrue(config.sendContentLength);
      assert.deepStrictEqual(config.webhookPublicKey, Option.some("-----BEGIN PUBLIC KEY-----"));
      assert.deepStrictEqual(config.callbackBaseUrl, Option.some("https://tunnel.example.com"));
      const other = yield* build({
        BLOB_READ_WRITE_TOKEN: rwToken,
        VERCEL_BLOB_USE_X_CONTENT_LENGTH: "true",
      });
      assert.isFalse(other.sendContentLength);
    }),
  );

  it.effect("lets options replace the environment", () =>
    Effect.gen(function* () {
      const base = (storeId: StoreId) => new URL(`http://127.0.0.1:9/${storeId}/`);
      const config = yield* build(
        {
          BLOB_READ_WRITE_TOKEN: rwToken,
          VERCEL_BLOB_API_URL: "http://localhost:3000/api/blob",
          VERCEL_BLOB_RETRIES: "4",
          VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API: "env",
          BLOB_WEBHOOK_PUBLIC_KEY: "env-key",
          VERCEL_BLOB_CALLBACK_URL: "https://env.example.com",
        },
        {
          apiUrl: new URL("http://127.0.0.1:8/api/blob"),
          retries: 1,
          headers: { "x-extra": "1", "x-proxy-through-alternative-api": "option" },
          blobBaseUrl: base,
          webhookPublicKey: "option-key",
          callbackBaseUrl: "https://option.example.com",
        },
      );
      assert.strictEqual(config.apiUrl.href, "http://127.0.0.1:8/api/blob");
      assert.strictEqual(config.retries, 1);
      assert.deepStrictEqual(config.headers, {
        "x-proxy-through-alternative-api": "option",
        "x-extra": "1",
      });
      assert.strictEqual(
        config.blobBaseUrl(StoreId.make("s"), "public").href,
        "http://127.0.0.1:9/s/",
      );
      assert.deepStrictEqual(config.webhookPublicKey, Option.some("option-key"));
      assert.deepStrictEqual(config.callbackBaseUrl, Option.some("https://option.example.com"));
    }),
  );

  it.effect("fails without credentials", () =>
    Effect.gen(function* () {
      const message = yield* failure({});
      assert.include(message, "No blob credentials found");
    }),
  );

  it.effect("fails on a read-write token without a store id", () =>
    Effect.gen(function* () {
      assert.include(yield* failure({ BLOB_READ_WRITE_TOKEN: "123" }), "BLOB_READ_WRITE_TOKEN");
      assert.include(yield* failure({}, { token: "123" }), "token option");
      assert.include(
        yield* failure({ BLOB_READ_WRITE_TOKEN: "123", BLOB_STORE_ID: "s" }),
        "BLOB_READ_WRITE_TOKEN",
      );
    }),
  );

  it.effect("fails on an invalid store id, API URL or retry count", () =>
    Effect.gen(function* () {
      assert.include(yield* failure({ BLOB_STORE_ID: "store_a_b" }), "Invalid store id");
      assert.include(
        yield* failure({ BLOB_READ_WRITE_TOKEN: rwToken, VERCEL_BLOB_API_URL: "not a url" }),
        "Invalid Blob API URL",
      );
      assert.include(
        yield* failure({ BLOB_READ_WRITE_TOKEN: rwToken, VERCEL_BLOB_RETRIES: "ten" }),
        "VERCEL_BLOB_RETRIES",
      );
      assert.include(
        yield* failure({ BLOB_READ_WRITE_TOKEN: rwToken, VERCEL_BLOB_RETRIES: "-1" }),
        "VERCEL_BLOB_RETRIES",
      );
      assert.include(
        yield* failure({ BLOB_READ_WRITE_TOKEN: rwToken }, { retries: 1.5 }),
        "retries",
      );
    }),
  );
});
