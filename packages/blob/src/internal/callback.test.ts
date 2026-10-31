import type { VercelSystemEnv } from "@panorama-industries/effect-vercel-core";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, Option } from "effect";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  callbackUrlUndeterminedWarning,
  callbackUrlUnhandledWarning,
  deriveCallbackUrl,
  parseCallbackBody,
  publicKeyDerFromPem,
  requestPath,
  resolveCallbackUrl,
  verifyEd25519CallbackSignature,
  verifyHmacCallbackSignature,
} from "./callback.ts";

const offVercel: VercelSystemEnv["Service"] = {
  region: Option.none(),
  deploymentId: Option.none(),
  projectId: Option.none(),
  target: Option.none(),
  url: Option.none(),
  branchUrl: Option.none(),
  projectProductionUrl: Option.none(),
  isVercel: false,
  isDevelopment: false,
  cliVersion: Option.none(),
};

const recordWarnings = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    const recorder = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    const value = yield* effect.pipe(Effect.provide(Logger.layer([recorder])));
    return { value, warnings: warnings.flat() };
  });

const derive = (
  requestUrl: string,
  env: Partial<VercelSystemEnv["Service"]>,
  callbackBaseUrl?: string,
) =>
  deriveCallbackUrl({
    requestUrl,
    callbackBaseUrl: Option.fromUndefinedOr(callbackBaseUrl),
    env: { ...offVercel, ...env },
  });

describe("requestPath", () => {
  it("keeps the path and query of absolute and relative URLs", () => {
    assert.deepStrictEqual(
      requestPath("http://localhost:3000/api/upload?test=1"),
      Option.some("/api/upload?test=1"),
    );
    assert.deepStrictEqual(
      requestPath("/api/upload?example=test"),
      Option.some("/api/upload?example=test"),
    );
    assert.deepStrictEqual(requestPath("http://[::1"), Option.none());
  });
});

describe("deriveCallbackUrl", () => {
  it.effect("uses the callback base URL with the request path and query, on or off Vercel", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* derive("/api/upload?userId=123&type=avatar", {}, "https://webhook.example.com"),
        Option.some("https://webhook.example.com/api/upload?userId=123&type=avatar"),
      );
      assert.deepStrictEqual(
        yield* derive(
          "/api/upload",
          { isVercel: true, target: Option.some("production") },
          "https://custom-callback.example.com",
        ),
        Option.some("https://custom-callback.example.com/api/upload"),
      );
    }),
  );

  it.effect("uses the branch URL, then the deployment URL, of a preview", () =>
    Effect.gen(function* () {
      const preview = { isVercel: true, target: Option.some("preview" as const) };
      assert.deepStrictEqual(
        yield* derive("http://localhost:3000/api/upload?test=1", {
          ...preview,
          branchUrl: Option.some("branch-abc-123.vercel.app"),
          url: Option.some("ignored.vercel.app"),
        }),
        Option.some("https://branch-abc-123.vercel.app/api/upload?test=1"),
      );
      assert.deepStrictEqual(
        yield* derive("/api/upload", {
          ...preview,
          url: Option.some("myapp-git-feature-user.vercel.app"),
        }),
        Option.some("https://myapp-git-feature-user.vercel.app/api/upload"),
      );
      assert.deepStrictEqual(
        yield* derive("/api/upload", {
          ...preview,
          projectProductionUrl: Option.some("myapp.vercel.app"),
        }),
        Option.none(),
      );
    }),
  );

  it.effect("uses the production URL in production", () =>
    Effect.gen(function* () {
      const production = { isVercel: true, target: Option.some("production" as const) };
      assert.deepStrictEqual(
        yield* derive("/api/blob/upload", {
          ...production,
          projectProductionUrl: Option.some("myapp.vercel.app"),
        }),
        Option.some("https://myapp.vercel.app/api/blob/upload"),
      );
      assert.deepStrictEqual(yield* derive("/api/upload", production), Option.none());
      assert.deepStrictEqual(
        yield* derive("/api/upload", {
          isVercel: true,
          target: Option.some("development"),
          projectProductionUrl: Option.some("myapp.vercel.app"),
        }),
        Option.none(),
      );
    }),
  );

  it.effect("warns and gives none off Vercel without a callback base URL", () =>
    Effect.gen(function* () {
      const { value, warnings } = yield* recordWarnings(
        derive("/api/upload", { target: Option.some("production") }),
      );
      assert.deepStrictEqual(value, Option.none());
      assert.deepStrictEqual(warnings, [callbackUrlUndeterminedWarning]);
    }),
  );
});

describe("resolveCallbackUrl", () => {
  const derived = Effect.succeed(Option.some("https://derived.example.com/route"));

  it.effect("prefers the route's URL and derives one only with a handler", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* resolveCallbackUrl({
          provided: "https://route.example.com",
          handlesCallback: true,
          derive: derived,
        }),
        Option.some("https://route.example.com"),
      );
      assert.deepStrictEqual(
        yield* resolveCallbackUrl({ provided: "", handlesCallback: true, derive: derived }),
        Option.some("https://derived.example.com/route"),
      );
      assert.deepStrictEqual(
        yield* resolveCallbackUrl({ provided: undefined, handlesCallback: false, derive: derived }),
        Option.none(),
      );
    }),
  );

  it.effect("warns when a route URL has no handler, and keeps it", () =>
    Effect.gen(function* () {
      const { value, warnings } = yield* recordWarnings(
        resolveCallbackUrl({
          provided: "https://example.com/callback",
          handlesCallback: false,
          derive: derived,
        }),
      );
      assert.deepStrictEqual(value, Option.some("https://example.com/callback"));
      assert.deepStrictEqual(warnings, [callbackUrlUnhandledWarning]);
    }),
  );
});

describe("parseCallbackBody", () => {
  it("re-serializes JSON as JSON.stringify(JSON.parse(body))", () => {
    assert.deepStrictEqual(
      Option.map(parseCallbackBody('{ "b": 1,\n "a": [1, 2] }'), (body) => body.normalized),
      Option.some('{"b":1,"a":[1,2]}'),
    );
    assert.isTrue(Option.isNone(parseCallbackBody("not json")));
  });
});

describe("verifyHmacCallbackSignature", () => {
  // Golden vector from the SDK's client.node.test.ts.
  const token = "vercel_blob_client_123456789_TEST_TOKEN";
  const body = JSON.stringify({
    type: "blob.upload-completed",
    payload: { blob: { pathname: "newfile.txt" }, tokenPayload: "custom-metadata" },
  });
  const signature = "a4eac582498d4548d701eb8ff3e754f33f078e75298b9a1a0cdbac128981b28d";

  it.effect("verifies the SDK's golden signature", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* verifyHmacCallbackSignature(token, signature, body));
      assert.isTrue(yield* verifyHmacCallbackSignature(token, signature.toUpperCase(), body));
    }),
  );

  it.effect("rejects other bodies, keys and non-hex signatures", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* verifyHmacCallbackSignature(token, signature, `${body} `));
      assert.isFalse(yield* verifyHmacCallbackSignature(`${token}x`, signature, body));
      assert.isFalse(yield* verifyHmacCallbackSignature(token, "123", body));
      assert.isFalse(yield* verifyHmacCallbackSignature(token, "zz", body));
    }),
  );
});

describe("verifyEd25519CallbackSignature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const body = '{"type":"blob.upload-completed","payload":{"blob":{"pathname":"x"}}}';
  const signatureOf = (text: string) =>
    Buffer.from(sign(null, Buffer.from(text, "utf8"), privateKey)).toString("hex");

  it.effect("verifies a signature made by the key", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* verifyEd25519CallbackSignature(pem, signatureOf(body), body));
    }),
  );

  it.effect("rejects other bodies, keys and HMAC-shaped signatures", () =>
    Effect.gen(function* () {
      const other = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString();
      assert.isFalse(yield* verifyEd25519CallbackSignature(pem, signatureOf(`${body} `), body));
      assert.isFalse(yield* verifyEd25519CallbackSignature(other, signatureOf(body), body));
      assert.isFalse(
        yield* verifyEd25519CallbackSignature(
          pem,
          "a4eac582498d4548d701eb8ff3e754f33f078e75298b9a1a0cdbac128981b28d",
          body,
        ),
      );
      assert.isFalse(yield* verifyEd25519CallbackSignature("not a key", signatureOf(body), body));
      const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
        .publicKey.export({ type: "spki", format: "pem" })
        .toString();
      assert.isFalse(yield* verifyEd25519CallbackSignature(rsa, signatureOf(body), body));
    }),
  );

  it("reads the DER of a PEM public key", () => {
    assert.deepStrictEqual(
      Option.map(publicKeyDerFromPem(pem), (der) => Buffer.from(der).toString("base64")),
      Option.some(publicKey.export({ type: "spki", format: "der" }).toString("base64")),
    );
    assert.isTrue(
      Option.isNone(publicKeyDerFromPem("-----BEGIN PUBLIC KEY----------END PUBLIC KEY-----")),
    );
  });
});
