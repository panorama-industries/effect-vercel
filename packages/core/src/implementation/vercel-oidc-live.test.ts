import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";

import { OidcTokenUnavailable, VercelOidc } from "../contracts/vercel-oidc.ts";
import { VercelOidcLive, vercelOidcFromToken } from "./vercel-oidc-live.ts";

const requestContextKey = Symbol.for("@vercel/request-context");

const withRequestHeaders = (headers: () => Record<string, string> | undefined) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Reflect.set(globalThis, requestContextKey, { get: () => ({ headers: headers() }) }),
    ),
    () => Effect.sync(() => Reflect.deleteProperty(globalThis, requestContextKey)),
  );

const live = (env: Record<string, string>) =>
  VercelOidcLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));

const token = Effect.gen(function* () {
  const oidc = yield* VercelOidc;
  return Redacted.value(yield* oidc.token);
});

describe("VercelOidcLive", () => {
  it.effect("reads the token from the request header", () =>
    Effect.gen(function* () {
      yield* withRequestHeaders(() => ({ "x-vercel-oidc-token": "request-token" }));
      assert.strictEqual(yield* token, "request-token");
    }).pipe(Effect.scoped, Effect.provide(live({ VERCEL_OIDC_TOKEN: "env-token" }))),
  );

  it.effect("reads the current request on every evaluation", () =>
    Effect.gen(function* () {
      let current = "first";
      yield* withRequestHeaders(() => ({ "x-vercel-oidc-token": current }));
      const oidc = yield* VercelOidc;
      assert.strictEqual(Redacted.value(yield* oidc.token), "first");
      current = "second";
      assert.strictEqual(Redacted.value(yield* oidc.token), "second");
    }).pipe(Effect.scoped, Effect.provide(live({}))),
  );

  it.effect("falls back to VERCEL_OIDC_TOKEN", () =>
    Effect.gen(function* () {
      yield* withRequestHeaders(() => ({}));
      assert.strictEqual(yield* token, "env-token");
    }).pipe(Effect.scoped, Effect.provide(live({ VERCEL_OIDC_TOKEN: "env-token" }))),
  );

  it.effect("falls back to VERCEL_OIDC_TOKEN without a request context", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* token, "env-token");
    }).pipe(Effect.provide(live({ VERCEL_OIDC_TOKEN: "env-token" }))),
  );

  it.effect("ignores a malformed request context", () =>
    Effect.gen(function* () {
      yield* withRequestHeaders(() => undefined);
      assert.strictEqual(yield* token, "env-token");
    }).pipe(Effect.scoped, Effect.provide(live({ VERCEL_OIDC_TOKEN: "env-token" }))),
  );

  it.effect("fails with OidcTokenUnavailable when no token is present", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(token);
      assert.instanceOf(error, OidcTokenUnavailable);
      assert.include(error.message, "x-vercel-oidc-token");
      assert.include(error.message, "VERCEL_OIDC_TOKEN");
    }).pipe(Effect.provide(live({}))),
  );

  it.effect("hides the token value", () =>
    Effect.gen(function* () {
      const oidc = yield* VercelOidc;
      assert.notInclude(JSON.stringify(yield* oidc.token), "secret");
    }).pipe(Effect.provide(live({ VERCEL_OIDC_TOKEN: "secret" }))),
  );
});

describe("vercelOidcFromToken", () => {
  it.effect("supplies the given token", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* token, "fixed");
    }).pipe(Effect.provide(vercelOidcFromToken(Redacted.make("fixed")))),
  );
});
