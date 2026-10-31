import { assert, describe, it } from "@effect/vitest";
import * as sdk from "@vercel/blob";
import { DateTime, Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { createHmac } from "node:crypto";
import { afterEach, vi } from "vitest";

import type { PresignOptions, SigningToken } from "../../src/contracts/blob-signed-urls.ts";

import { ETag } from "../../src/contracts/blob-domain.ts";
import { BlobSignedUrls } from "../../src/contracts/blob-signed-urls.ts";
import { BlobSignedUrlsLive } from "../../src/implementation/blob-signed-urls-live.ts";
import {
  compare,
  differential,
  errorMapping,
  json,
  oidcSetup,
  ourOutcome,
  readWriteSetup,
  sdkOutcome,
  storeId,
  withoutTag,
} from "./harness.ts";

const run = (setup = readWriteSetup) =>
  differential(BlobSignedUrlsLive, setup, { defaultBlobBaseUrl: true });

/** Fixed time of every deterministic comparison. */
const now = Date.parse("2026-03-01T10:00:00.000Z");

const signingSecret = "differential-signing-secret";

/** A delegation token like `api-blob` issues (the SDK's `createDelegationToken` test helper). */
const delegation = (scope: {
  readonly pathname?: string;
  readonly operations?: ReadonlyArray<string>;
  readonly validUntil?: number;
  readonly maximumSizeInBytes?: number;
  readonly allowedContentTypes?: ReadonlyArray<string>;
}): SigningToken & { readonly sdk: { delegationToken: string; clientSigningToken: string } } => {
  const payload = Buffer.from(
    JSON.stringify({
      storeId,
      ownerId: "team_1",
      pathname: scope.pathname ?? "*",
      operations: scope.operations ?? ["get", "head", "put", "delete"],
      validUntil: scope.validUntil ?? now + 3_600_000,
      iat: now - 1000,
      ...(scope.maximumSizeInBytes === undefined
        ? {}
        : { maximumSizeInBytes: scope.maximumSizeInBytes }),
      ...(scope.allowedContentTypes === undefined
        ? {}
        : { allowedContentTypes: scope.allowedContentTypes }),
    }),
  ).toString("base64url");
  const delegationToken = `${payload}.${createHmac("sha256", signingSecret)
    .update(payload)
    .digest("base64url")}`;
  const clientSigningToken = createHmac("sha256", signingSecret)
    .update(delegationToken)
    .digest("base64url");
  return {
    delegationToken,
    clientSigningToken: Redacted.make(clientSigningToken),
    sdk: { delegationToken, clientSigningToken },
  };
};

const utc = (millis: number) => DateTime.makeUnsafe(millis);

/** Run an SDK call with `Date` frozen at {@link now}. */
const atFixedTime = <A>(call: () => Promise<A>): Promise<A> => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  return call().finally(() => vi.useRealTimers());
};

afterEach(() => {
  vi.useRealTimers();
});

/** The payload of a presigned URL: every signed `vercel-blob-*` query parameter. */
const payloadOfUrl = (url: string) => {
  const search = new URL(url).searchParams;
  const params: Record<string, string> = {};
  for (const [key, value] of search) {
    if (
      key.startsWith("vercel-blob-") &&
      key !== "vercel-blob-delegation" &&
      key !== "vercel-blob-signature"
    ) {
      params[key] = value;
    }
  }
  return {
    delegationToken: search.get("vercel-blob-delegation"),
    signature: search.get("vercel-blob-signature"),
    params,
  };
};

type Case = readonly [
  name: string,
  token: ReturnType<typeof delegation>,
  sdkOptions: sdk.PresignUrlOptions,
  ourOptions: PresignOptions,
];

const fullToken = delegation({});

const successCases: ReadonlyArray<Case> = [
  [
    "get",
    fullToken,
    { operation: "get", pathname: "a.txt" },
    { operation: "get", pathname: "a.txt" },
  ],
  [
    "get with earlier validUntil",
    fullToken,
    { operation: "get", pathname: "dir/ü b.txt", validUntil: now + 60_000 },
    { operation: "get", pathname: "dir/ü b.txt", validUntil: utc(now + 60_000) },
  ],
  [
    "validUntil after the token's is clamped to it",
    fullToken,
    { operation: "get", pathname: "a.txt", validUntil: now + 7_200_000 },
    { operation: "get", pathname: "a.txt", validUntil: utc(now + 7_200_000) },
  ],
  [
    "head",
    fullToken,
    { operation: "head", pathname: "a.txt" },
    { operation: "head", pathname: "a.txt" },
  ],
  [
    "put with every option",
    fullToken,
    {
      operation: "put",
      pathname: "uploads/a.png",
      validUntil: now + 120_000,
      allowedContentTypes: ["image/png", "image/*"],
      maximumSizeInBytes: 1000,
      onUploadCompleted: {
        callbackUrl: "https://app.example.com/api/done",
        tokenPayload: '{"u":1}',
      },
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 3600,
      ifMatch: '"e1"',
    },
    {
      operation: "put",
      pathname: "uploads/a.png",
      validUntil: utc(now + 120_000),
      allowedContentTypes: ["image/png", "image/*"],
      maximumSizeInBytes: 1000,
      onUploadCompleted: {
        callbackUrl: "https://app.example.com/api/done",
        tokenPayload: '{"u":1}',
      },
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 3600,
      ifMatch: ETag.make('"e1"'),
    },
  ],
  [
    "put within the token's constraints",
    delegation({ maximumSizeInBytes: 5000, allowedContentTypes: ["image/*"] }),
    {
      operation: "put",
      pathname: "a.png",
      maximumSizeInBytes: 10,
      allowedContentTypes: ["image/png"],
    },
    {
      operation: "put",
      pathname: "a.png",
      maximumSizeInBytes: 10,
      allowedContentTypes: ["image/png"],
    },
  ],
  [
    "put inheriting the token's constraints",
    delegation({ maximumSizeInBytes: 5000, allowedContentTypes: ["image/*"] }),
    { operation: "put", pathname: "a.png" },
    { operation: "put", pathname: "a.png" },
  ],
  [
    "delete with ifMatch",
    fullToken,
    { operation: "delete", pathname: "a.txt", ifMatch: '"e2"' },
    { operation: "delete", pathname: "a.txt", ifMatch: ETag.make('"e2"') },
  ],
  [
    "scoped token",
    delegation({ pathname: "only.txt", operations: ["get"] }),
    { operation: "get", pathname: "only.txt" },
    { operation: "get", pathname: "only.txt" },
  ],
];

const failureCases: ReadonlyArray<Case> = [
  [
    "pathname outside the token's scope",
    delegation({ pathname: "only.txt" }),
    { operation: "get", pathname: "other.txt" },
    { operation: "get", pathname: "other.txt" },
  ],
  [
    "expired token",
    delegation({ validUntil: now - 1 }),
    { operation: "get", pathname: "a.txt" },
    { operation: "get", pathname: "a.txt" },
  ],
  ...(["get", "head", "put", "delete"] as const).map((operation): Case => [
    `${operation} not delegated`,
    delegation({ operations: ["get", "head", "put", "delete"].filter((op) => op !== operation) }),
    { operation, pathname: "a.txt" } as sdk.PresignUrlOptions,
    { operation, pathname: "a.txt" } as PresignOptions,
  ]),
  [
    "validUntil in the past",
    fullToken,
    { operation: "get", pathname: "a.txt", validUntil: now - 1000 },
    { operation: "get", pathname: "a.txt", validUntil: utc(now - 1000) },
  ],
  [
    "maximumSizeInBytes above the token's",
    delegation({ maximumSizeInBytes: 10 }),
    { operation: "put", pathname: "a.png", maximumSizeInBytes: 11 },
    { operation: "put", pathname: "a.png", maximumSizeInBytes: 11 },
  ],
  [
    "content type outside the token's",
    delegation({ allowedContentTypes: ["image/*"] }),
    { operation: "put", pathname: "a.txt", allowedContentTypes: ["text/plain"] },
    { operation: "put", pathname: "a.txt", allowedContentTypes: ["text/plain"] },
  ],
  [
    "cacheControlMaxAge above one year",
    fullToken,
    { operation: "put", pathname: "a.txt", cacheControlMaxAge: 365 * 24 * 3600 + 1 },
    { operation: "put", pathname: "a.txt", cacheControlMaxAge: 365 * 24 * 3600 + 1 },
  ],
  [
    "relative callback URL",
    fullToken,
    { operation: "put", pathname: "a.txt", onUploadCompleted: { callbackUrl: "/api/done" } },
    { operation: "put", pathname: "a.txt", onUploadCompleted: { callbackUrl: "/api/done" } },
  ],
];

describe("differential: @vercel/blob@2.8.2 vs BlobSignedUrlsLive", () => {
  describe("presignUrl and presign at a fixed time", () => {
    it.effect("produce byte-identical URLs and payloads", () =>
      Effect.gen(function* () {
        const signed = yield* BlobSignedUrls;
        yield* TestClock.setTime(now);
        for (const [name, token, sdkOptions, ourOptions] of successCases) {
          for (const access of ["public", "private"] as const) {
            const label = `${name} (${access})`;
            const sdkUrl = yield* sdkOutcome(
              () => atFixedTime(() => sdk.presignUrl(token.sdk, { ...sdkOptions, access })),
              (result) => result.presignedUrl,
            );
            const ourUrl = yield* ourOutcome(
              signed.presignUrl(token, { ...ourOptions, access }),
              (url) => url.href,
            );
            assert.property(sdkUrl, "ok", `${label}: the SDK refused it`);
            assert.deepStrictEqual(withoutTag(ourUrl), sdkUrl, label);
            const ourPayload = yield* ourOutcome(signed.presign(token, ourOptions), (payload) => ({
              delegationToken: payload.delegationToken,
              signature: payload.signature,
              params: { ...payload.params },
            }));
            assert.deepStrictEqual(
              withoutTag(ourPayload),
              "ok" in sdkUrl ? { ok: payloadOfUrl(sdkUrl.ok) } : sdkUrl,
              `${label}: payload`,
            );
          }
        }
      }).pipe(run()),
    );

    it.effect("add cache=0 outside the signature only for private get with useCache: false", () =>
      Effect.gen(function* () {
        const signed = yield* BlobSignedUrls;
        yield* TestClock.setTime(now);
        for (const access of ["public", "private"] as const) {
          for (const useCache of [undefined, true, false]) {
            const sdkUrl = yield* sdkOutcome(
              () =>
                atFixedTime(() =>
                  sdk.presignUrl(fullToken.sdk, {
                    operation: "get",
                    pathname: "a.txt",
                    access,
                    ...(useCache === undefined ? {} : { useCache }),
                  }),
                ),
              (result) => result.presignedUrl,
            );
            const ourUrl = yield* ourOutcome(
              signed.presignUrl(fullToken, {
                operation: "get",
                pathname: "a.txt",
                access,
                ...(useCache === undefined ? {} : { useCache }),
              }),
              (url) => url.href,
            );
            assert.property(sdkUrl, "ok");
            assert.deepStrictEqual(withoutTag(ourUrl), sdkUrl, `${access} ${useCache}`);
          }
        }
      }).pipe(run()),
    );

    it.effect("presign a full blob URL like the SDK", () =>
      Effect.gen(function* () {
        const signed = yield* BlobSignedUrls;
        yield* TestClock.setTime(now);
        const url = `https://${storeId}.private.blob.vercel-storage.com/dir/a.txt`;
        const sdkUrl = yield* sdkOutcome(
          () =>
            atFixedTime(() =>
              sdk.presignUrl(fullToken.sdk, { operation: "get", pathname: url, access: "private" }),
            ),
          (result) => result.presignedUrl,
        );
        const ourUrl = yield* ourOutcome(
          signed.presignUrl(fullToken, { operation: "get", pathname: url, access: "private" }),
          (result) => result.href,
        );
        assert.deepStrictEqual(withoutTag(ourUrl), sdkUrl);
      }).pipe(run()),
    );

    it.effect("refuse the same options with the same messages", () =>
      Effect.gen(function* () {
        const signed = yield* BlobSignedUrls;
        yield* TestClock.setTime(now);
        for (const [name, token, sdkOptions, ourOptions] of failureCases) {
          const sdkResult = yield* sdkOutcome(
            () => atFixedTime(() => sdk.presignUrl(token.sdk, { ...sdkOptions, access: "public" })),
            (result) => result.presignedUrl,
          );
          const ourResult = yield* ourOutcome(
            signed.presignUrl(token, { ...ourOptions, access: "public" }),
            (url) => url.href,
          );
          assert.property(sdkResult, "error", `${name}: the SDK accepted it`);
          assert.deepStrictEqual(withoutTag(ourResult), sdkResult, name);
          assert.strictEqual(ourResult.tag, "BlobPresignFailed", `${name}: tag`);
        }
      }).pipe(run()),
    );
  });

  describe("issueSignedToken", () => {
    const validUntil = now + 86_400_000;
    const tokenResponse = json({
      delegationToken: "payload.signature",
      clientSigningToken: "client-secret",
      validUntil,
    });
    const normalizeSdk = (token: sdk.IssuedSignedToken) => ({
      delegationToken: token.delegationToken,
      clientSigningToken: token.clientSigningToken,
      validUntil: token.validUntil,
    });

    const issueBoth = (
      sdkOptions: sdk.IssueSignedTokenOptions,
      ourOptions: Parameters<BlobSignedUrls["Service"]["issueSignedToken"]>[0],
      responder: Parameters<typeof compare>[0] = tokenResponse,
    ) =>
      Effect.gen(function* () {
        const signed = yield* BlobSignedUrls;
        return yield* compare(
          responder,
          () => sdkOutcome(() => sdk.issueSignedToken(sdkOptions), normalizeSdk),
          ourOutcome(signed.issueSignedToken(ourOptions), (token) => ({
            delegationToken: token.delegationToken,
            clientSigningToken: Redacted.value(token.clientSigningToken),
            validUntil: DateTime.toEpochMillis(token.validUntil),
          })),
        );
      });

    const assertSame = (result: Effect.Success<ReturnType<typeof issueBoth>>, name = "") => {
      assert.isAbove(result.sdkRequests.length, 0, name);
      assert.deepStrictEqual(result.ourRequests, result.sdkRequests, `${name}: requests`);
      assert.deepStrictEqual(withoutTag(result.ours), result.sdk, `${name}: outcome`);
    };

    it.live("sends identical requests for every option", () =>
      Effect.gen(function* () {
        const future = Date.now() + 3_600_000;
        assertSame(yield* issueBoth({}, undefined), "no options");
        assertSame(yield* issueBoth({}, {}), "empty options");
        assertSame(
          yield* issueBoth(
            {
              pathname: "uploads/*",
              operations: ["put", "get", "put"],
              validUntil: future,
              maximumSizeInBytes: 1024,
              allowedContentTypes: ["image/*"],
            },
            {
              pathname: "uploads/*",
              operations: ["put", "get", "put"],
              validUntil: utc(future),
              maximumSizeInBytes: 1024,
              allowedContentTypes: ["image/*"],
            },
          ),
          "every option",
        );
      }).pipe(run()),
    );

    it.live("sends identical requests with OIDC", () =>
      Effect.gen(function* () {
        assertSame(yield* issueBoth({ pathname: "a.txt" }, { pathname: "a.txt" }));
      }).pipe(run(oidcSetup)),
    );

    it.live("maps every error code like the SDK", () =>
      Effect.gen(function* () {
        const declares = ["BlobStoreUnavailable", "BlobOidcEnvironmentNotAllowed"];
        for (const row of errorMapping) {
          const result = yield* issueBoth({}, {}, row.response);
          assert.deepStrictEqual(result.ourRequests, result.sdkRequests, `${row.name}: requests`);
          assert.deepStrictEqual(result.sdk, { error: row.sdk }, `${row.name}: SDK`);
          const declared = row.domain === undefined || declares.includes(row.domain);
          assert.deepStrictEqual(
            withoutTag(result.ours),
            { error: declared ? row.sdk : (row.undeclared ?? row.sdk) },
            row.name,
          );
          if (declared) assert.strictEqual(result.ours.tag, row.ours, `${row.name}: tag`);
        }
      }).pipe(run()),
    );
  });
});
