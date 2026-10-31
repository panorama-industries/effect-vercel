import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option, Redacted } from "effect";
import { createHmac, randomBytes } from "node:crypto";

import type { PresignOptions, SigningToken } from "../contracts/blob-signed-urls.ts";
import type { PresignDelegation, PresignUrlConstraints } from "./presign.ts";

import { ETag, PresignedUrlPayload } from "../contracts/blob-domain.ts";
import { BlobPresignFailed } from "../contracts/blob-errors.ts";
import {
  canonicalString,
  delegationScope,
  hmacSha256Base64Url,
  presignCanonicalQueryEntries,
  presignedApiUrl,
  presignedBlobUrl,
  presignPayload,
  presignQueryValidUntil,
} from "./presign.ts";
import { defaultBlobBaseUrl } from "./urls.ts";

// Port of the SDK's signed-token.presignurl.test-helpers.ts (api-blob's `createDelegationToken`).
const createDelegationToken = (payload: Record<string, unknown>, secret: string): string => {
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(segment, "utf8").digest("base64url");
  return `${segment}.${signature}`;
};

const deriveClientSigningToken = (secret: string, delegationToken: string): string =>
  createHmac("sha256", secret).update(delegationToken, "utf8").digest("base64url");

const storeId = "s".repeat(16);
const blobSigningSecret = randomBytes(32).toString("base64");
const now = Date.now();

const signedToken = (
  scope: Record<string, unknown>,
): SigningToken & { readonly clientSigningToken: Redacted.Redacted<string> } => {
  const delegationToken = createDelegationToken(
    { storeId: `store_${storeId}`, ownerId: "owner_1", iat: now, ...scope },
    blobSigningSecret,
  );
  return {
    delegationToken,
    clientSigningToken: Redacted.make(deriveClientSigningToken(blobSigningSecret, delegationToken)),
  };
};

const at = (millis: number) => DateTime.makeUnsafe(millis);

const fail = <A>(effect: Effect.Effect<A, BlobPresignFailed>) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.instanceOf(error, BlobPresignFailed);
    return error.message;
  });

/** The SDK's `expectSignatureMatches`: recompute the entries and HMAC independently. */
const expectSignatureMatches = Effect.fnUntraced(function* (
  token: SigningToken,
  options: PresignOptions,
  nowMs: number,
) {
  const payload = yield* presignPayload(token, options, nowMs);
  const scope = Option.getOrThrow(delegationScope(token.delegationToken));
  const millis = (value: DateTime.Utc | undefined) =>
    value === undefined ? undefined : DateTime.toEpochMillis(value);
  const urlOptions: PresignUrlConstraints =
    options.operation === "put"
      ? {
          validUntil: millis(options.validUntil),
          allowedContentTypes: options.allowedContentTypes,
          maximumSizeInBytes: options.maximumSizeInBytes,
          addRandomSuffix: options.addRandomSuffix,
          allowOverwrite: options.allowOverwrite,
          cacheControlMaxAge: options.cacheControlMaxAge,
          ifMatch: options.ifMatch,
          onUploadCompleted: options.onUploadCompleted,
        }
      : { validUntil: millis(options.validUntil) };
  const entries = yield* presignCanonicalQueryEntries({
    operation: options.operation,
    delegation: {
      validUntil: scope.validUntil,
      maximumSizeInBytes: scope.maximumSizeInBytes,
      allowedContentTypes: scope.allowedContentTypes,
    },
    urlOptions,
    now: nowMs,
  });
  const canonical = canonicalString(options.pathname, entries, options.operation);
  const expected = createHmac("sha256", Redacted.value(token.clientSigningToken))
    .update(canonical, "utf8")
    .digest("base64url");
  assert.strictEqual(payload.signature, expected);
  assert.strictEqual(payload.delegationToken, token.delegationToken);
  assert.deepStrictEqual(payload.params, Object.fromEntries(entries));
});

// Port of signed-token.presignurl.shared-spec.ts.
describe("presignPayload (SDK shared spec)", () => {
  it.effect("PUT: same signature for pathname whether target is PUT / or POST /mpu", () =>
    Effect.gen(function* () {
      const pathname = "images/a.png";
      const token = signedToken({ pathname, operations: ["put"], validUntil: now + 3600_000 });
      const put = yield* presignPayload(token, { operation: "put", pathname }, now);
      const mpu = yield* presignPayload(token, { operation: "put", pathname }, now);
      assert.strictEqual(put.signature, mpu.signature);
      assert.deepStrictEqual(put.params, mpu.params);
      yield* expectSignatureMatches(token, { operation: "put", pathname }, now);
      assert.isUndefined(put.params[presignQueryValidUntil]);
    }),
  );

  it.effect("POST /mpu: matches PUT canonical for the same pathname", () =>
    Effect.gen(function* () {
      const pathname = "images/a.png";
      const token = signedToken({ pathname, operations: ["put"], validUntil: now + 3600_000 });
      yield* expectSignatureMatches(token, { operation: "put", pathname }, now);
    }),
  );

  it.effect("HMACs the documented canonical string and returns payload fields", () =>
    Effect.gen(function* () {
      const pathname = "images/a.png";
      const token = signedToken({ pathname, operations: ["get"], validUntil: now + 3600_000 });
      yield* expectSignatureMatches(token, { operation: "get", pathname }, now);
    }),
  );

  it.effect("same pathname yields identical presign payloads (deterministic)", () =>
    Effect.gen(function* () {
      const pathname = "x.txt";
      const token = signedToken({ pathname, operations: ["get"], validUntil: now + 3600_000 });
      const first = yield* presignPayload(token, { operation: "get", pathname }, now);
      const second = yield* presignPayload(token, { operation: "get", pathname }, now);
      assert.deepStrictEqual(first, second);
    }),
  );

  it.effect("accepts logical pathname when the object URL would use percent-encoded segments", () =>
    Effect.gen(function* () {
      const pathname = "Image Background Removed (1).png";
      const token = signedToken({ pathname, operations: ["get"], validUntil: now + 3600_000 });
      yield* expectSignatureMatches(token, { operation: "get", pathname }, now);
    }),
  );

  it.effect("rejects path mismatch for scoped non-wildcard tokens", () =>
    Effect.gen(function* () {
      const token = signedToken({
        ownerId: "o",
        pathname: "a.png",
        operations: ["get"],
        validUntil: now + 3600_000,
      });
      const message = yield* fail(
        presignPayload(token, { operation: "get", pathname: "b.png" }, now),
      );
      assert.strictEqual(
        message,
        "Blob path does not match the signed token scope; expected `a.png`, got `b.png`.",
      );
    }),
  );

  it.effect(
    "adds signed `vercel-blob-valid-until` when `validUntil` is before delegation ceiling",
    () =>
      Effect.gen(function* () {
        const fixedNow = 1_700_000_000_000;
        const pathname = "images/a.png";
        const token = signedToken({
          pathname,
          operations: ["get"],
          validUntil: fixedNow + 3_600_000,
          iat: fixedNow,
        });
        const presignedUntil = fixedNow + 90_000;
        const options: PresignOptions = {
          operation: "get",
          pathname,
          validUntil: at(presignedUntil),
        };
        const payload = yield* presignPayload(token, options, fixedNow);
        assert.strictEqual(payload.params[presignQueryValidUntil], String(presignedUntil));
        yield* expectSignatureMatches(token, options, fixedNow);
      }),
  );

  it.effect("omits `vercel-blob-valid-until` when `validUntil` equals delegation ceiling", () =>
    Effect.gen(function* () {
      const fixedNow = 2_000_000_000_000;
      const validUntil = fixedNow + 120_000;
      const pathname = "a.png";
      const token = signedToken({
        ownerId: "o",
        pathname,
        operations: ["get"],
        validUntil,
        iat: fixedNow,
      });
      const options: PresignOptions = { operation: "get", pathname, validUntil: at(validUntil) };
      const payload = yield* presignPayload(token, options, fixedNow);
      assert.isUndefined(payload.params[presignQueryValidUntil]);
      yield* expectSignatureMatches(token, options, fixedNow);
    }),
  );
});

describe("presignPayload (validation)", () => {
  const scoped = (operations: ReadonlyArray<string>, extra: Record<string, unknown> = {}) =>
    signedToken({ pathname: "*", operations, validUntil: now + 3600_000, ...extra });

  it.effect("requires both halves of the token", () =>
    Effect.gen(function* () {
      const message = yield* fail(
        presignPayload(
          { delegationToken: "", clientSigningToken: Redacted.make("x") },
          { operation: "get", pathname: "a" },
          now,
        ),
      );
      assert.strictEqual(
        message,
        "`clientSigningToken` and `delegationToken` from `issueSignedToken` are required.",
      );
    }),
  );

  it.effect("rejects an unreadable delegation token", () =>
    Effect.gen(function* () {
      for (const delegationToken of ["not-a-jwt", "!!!.sig", "bnVsbA.sig"]) {
        const message = yield* fail(
          presignPayload(
            { delegationToken, clientSigningToken: Redacted.make("Zm9v") },
            { operation: "get", pathname: "a.png" },
            now,
          ),
        );
        assert.strictEqual(message, "Invalid or unreadable `delegationToken` payload.");
      }
    }),
  );

  it.effect("accepts any pathname with a wildcard or empty scope", () =>
    Effect.gen(function* () {
      yield* presignPayload(scoped(["get"]), { operation: "get", pathname: "any/where" }, now);
      yield* presignPayload(
        signedToken({ operations: ["get"], validUntil: now + 1000 }),
        { operation: "get", pathname: "any/where" },
        now,
      );
    }),
  );

  it.effect("rejects an expired delegation", () =>
    Effect.gen(function* () {
      const message = yield* fail(
        presignPayload(
          scoped(["get"], { validUntil: now - 1 }),
          { operation: "get", pathname: "a" },
          now,
        ),
      );
      assert.strictEqual(message, "The signed delegation has expired; issue a new token first.");
    }),
  );

  it.effect("rejects an expiry that is not after now", () =>
    Effect.gen(function* () {
      const message = yield* fail(
        presignPayload(
          scoped(["get"], { validUntil: now }),
          { operation: "get", pathname: "a" },
          now,
        ),
      );
      assert.strictEqual(
        message,
        "presignUrl: resolved URL expiry is not after the current time; issue a new delegation token or pass a later validUntil.",
      );
    }),
  );

  it.effect("caps validUntil to the delegation's expiry", () =>
    Effect.gen(function* () {
      const payload = yield* presignPayload(
        scoped(["get"]),
        { operation: "get", pathname: "a", validUntil: at(now + 7200_000) },
        now,
      );
      assert.deepStrictEqual(payload.params, {});
    }),
  );

  it.effect("requires the operation to be delegated", () =>
    Effect.gen(function* () {
      const token = scoped([]);
      const messages = yield* Effect.all([
        fail(presignPayload(token, { operation: "get", pathname: "a" }, now)),
        fail(presignPayload(token, { operation: "head", pathname: "a" }, now)),
        fail(presignPayload(token, { operation: "put", pathname: "a" }, now)),
        fail(presignPayload(token, { operation: "delete", pathname: "a" }, now)),
      ]);
      assert.deepStrictEqual(messages, [
        'The delegation token is not valid for `GET` requests. Include `"get"` in `operations` when calling `issueSignedToken`.',
        'The delegation token is not valid for `HEAD` requests. Include `"head"` in `operations` when calling `issueSignedToken`.',
        'The delegation token is not valid for presigned write requests. Include `"put"` in `operations` when calling `issueSignedToken`.',
        'The delegation token is not valid for presigned delete requests. Include `"delete"` in `operations` when calling `issueSignedToken`.',
      ]);
    }),
  );

  it.effect("signs head with operation=head and delete with ifMatch", () =>
    Effect.gen(function* () {
      const token = scoped(["get", "head", "delete"]);
      const get = yield* presignPayload(token, { operation: "get", pathname: "a" }, now);
      const head = yield* presignPayload(token, { operation: "head", pathname: "a" }, now);
      assert.notStrictEqual(get.signature, head.signature);
      const ifMatch = ETag.make('"etag"');
      const del = yield* presignPayload(
        token,
        { operation: "delete", pathname: "a", ifMatch },
        now,
      );
      assert.deepStrictEqual(del.params, { "vercel-blob-if-match": '"etag"' });
      yield* expectSignatureMatches(token, { operation: "head", pathname: "a" }, now);
    }),
  );

  it.effect("signs every put constraint in the SDK's order", () =>
    Effect.gen(function* () {
      const token = scoped(["put"], {
        maximumSizeInBytes: 1000,
        allowedContentTypes: ["image/*", "text/plain"],
      });
      const options: PresignOptions = {
        operation: "put",
        pathname: "a.png",
        validUntil: at(now + 60_000),
        allowedContentTypes: ["text/plain", "image/png"],
        maximumSizeInBytes: 999.9,
        addRandomSuffix: true,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
        ifMatch: ETag.make('"e"'),
        onUploadCompleted: { callbackUrl: "https://example.com/cb", tokenPayload: "tp" },
      };
      const payload = yield* presignPayload(token, options, now);
      assert.deepStrictEqual(Object.entries(payload.params), [
        ["vercel-blob-valid-until", String(now + 60_000)],
        ["vercel-blob-allowed-content-types", "image/png,text/plain"],
        ["vercel-blob-maximum-size-in-bytes", "999"],
        ["vercel-blob-add-random-suffix", "true"],
        ["vercel-blob-allow-overwrite", "false"],
        ["vercel-blob-cache-control-max-age", "60"],
        ["vercel-blob-if-match", '"e"'],
        ["vercel-blob-callback-url", "https://example.com/cb"],
        ["vercel-blob-callback-token-payload", "tp"],
      ]);
      yield* expectSignatureMatches(token, options, now);
    }),
  );

  it.effect("omits an empty callback tokenPayload", () =>
    Effect.gen(function* () {
      const payload = yield* presignPayload(
        scoped(["put"]),
        {
          operation: "put",
          pathname: "a",
          onUploadCompleted: { callbackUrl: "https://e.com", tokenPayload: "" },
        },
        now,
      );
      assert.deepStrictEqual(payload.params, { "vercel-blob-callback-url": "https://e.com" });
    }),
  );
});

describe("presignCanonicalQueryEntries", () => {
  const delegation: PresignDelegation = {
    validUntil: now + 3600_000,
    maximumSizeInBytes: 100,
    allowedContentTypes: ["image/*"],
  };
  const putFailure = (urlOptions: PresignUrlConstraints) =>
    fail(presignCanonicalQueryEntries({ operation: "put", delegation, urlOptions, now }));

  it.effect("rejects constraints wider than the delegation's", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* putFailure({ allowedContentTypes: ["image/png", "text/plain"] }),
        'presignUrl: allowedContentTypes entry "text/plain" is not permitted by the delegation token.',
      );
      assert.strictEqual(
        yield* putFailure({ maximumSizeInBytes: 101 }),
        "presignUrl: maximumSizeInBytes must be ≤ delegation (100).",
      );
    }),
  );

  it.effect("rejects invalid upload options with the SDK's messages", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [PresignUrlConstraints, string]> = [
        [
          { cacheControlMaxAge: 1.5 },
          "presignUrl: cacheControlMaxAge must be an integer between 0 and 31536000.",
        ],
        [
          { cacheControlMaxAge: 31536001 },
          "presignUrl: cacheControlMaxAge must be an integer between 0 and 31536000.",
        ],
        [{ ifMatch: "" }, "presignUrl: ifMatch must be a non-empty string."],
        [{ ifMatch: "x".repeat(257) }, "presignUrl: ifMatch is too long."],
        [{ ifMatch: "a\nb" }, "presignUrl: ifMatch contains disallowed control characters."],
        [
          { onUploadCompleted: { callbackUrl: "" } },
          "presignUrl: onUploadCompleted.callbackUrl must be a non-empty string.",
        ],
        [
          { onUploadCompleted: { callbackUrl: `https://e.com/${"x".repeat(4096)}` } },
          "presignUrl: onUploadCompleted.callbackUrl is too long.",
        ],
        [
          { onUploadCompleted: { callbackUrl: "not a url" } },
          "presignUrl: onUploadCompleted.callbackUrl must be a valid URL.",
        ],
        [
          { onUploadCompleted: { callbackUrl: "https://e.com", tokenPayload: "x".repeat(8193) } },
          "presignUrl: onUploadCompleted.tokenPayload is too long.",
        ],
        [
          { allowedContentTypes: Array.from({ length: 2000 }, (_, i) => `image/type-${i}`) },
          "presignUrl: allowedContentTypes query value is too long.",
        ],
      ];
      for (const [urlOptions, message] of cases) {
        assert.strictEqual(yield* putFailure(urlOptions), message);
      }
    }),
  );

  it.effect("signs no expiry for a delegation without one", () =>
    Effect.gen(function* () {
      const entries = yield* presignCanonicalQueryEntries({
        operation: "get",
        delegation: { validUntil: undefined },
        urlOptions: {},
        now,
      });
      assert.deepStrictEqual(entries, []);
    }),
  );
});

describe("canonicalString", () => {
  it("sorts operation, pathname and non-empty signed entries bytewise", () => {
    assert.strictEqual(
      canonicalString(
        "é/a.png",
        [
          ["vercel-blob-valid-until", "123"],
          ["vercel-blob-if-match", ""],
          ["unknown", "x"],
          ["vercel-blob-add-random-suffix", "true"],
        ],
        "put",
      ),
      [
        "operation=put",
        "pathname=é/a.png",
        "vercel-blob-add-random-suffix=true",
        "vercel-blob-valid-until=123",
      ].join("\n"),
    );
  });
});

describe("hmacSha256Base64Url", () => {
  it.effect("matches node:crypto", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* hmacSha256Base64Url("key", "data ✓"),
        createHmac("sha256", "key").update("data ✓").digest("base64url"),
      );
    }),
  );
});

describe("presigned URLs", () => {
  const token = signedToken({ pathname: "*", operations: ["get"], validUntil: now + 1000 });
  const payload = new PresignedUrlPayload({
    delegationToken: token.delegationToken,
    signature: "sig",
    params: { "vercel-blob-valid-until": "1" },
  });

  it("resolves a pathname under the delegation's store", () => {
    const url = Option.getOrThrow(
      presignedBlobUrl({
        pathnameOrUrl: "media/photo.png",
        payload,
        access: "private",
        useCache: false,
        blobBaseUrl: defaultBlobBaseUrl,
      }),
    );
    assert.strictEqual(
      url.href,
      `https://${storeId}.private.blob.vercel-storage.com/media/photo.png?cache=0&vercel-blob-valid-until=1&vercel-blob-delegation=${token.delegationToken}&vercel-blob-signature=sig`,
    );
  });

  it("requires a store id in the delegation token", () => {
    const withoutStore = new PresignedUrlPayload({
      delegationToken: `${Buffer.from("{}").toString("base64url")}.sig`,
      signature: "sig",
      params: {},
    });
    assert.isTrue(
      Option.isNone(
        presignedBlobUrl({
          pathnameOrUrl: "https://x.blob.vercel-storage.com/a",
          payload: withoutStore,
          access: "public",
          useCache: undefined,
          blobBaseUrl: defaultBlobBaseUrl,
        }),
      ),
    );
  });

  it("builds the Blob API URL for put and delete", () => {
    assert.strictEqual(
      presignedApiUrl(new URL("https://vercel.com/api/blob/"), "a b.png", payload).href,
      `https://vercel.com/api/blob/?pathname=a+b.png&vercel-blob-valid-until=1&vercel-blob-delegation=${token.delegationToken}&vercel-blob-signature=sig`,
    );
  });
});
