import { assert, describe, it } from "@effect/vitest";
import {
  ApiBadRequest,
  ApiForbidden,
  ApiUnexpectedResponse,
  VercelApiError,
  vercelOidcFromToken,
} from "@panorama-industries/effect-vercel-core";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import { ConfigProvider, DateTime, Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { createHmac, randomBytes } from "node:crypto";

import type { SigningToken } from "../contracts/blob-signed-urls.ts";

import {
  BlobPresignFailed,
  BlobStoreNotFound,
  BlobStoreUnavailable,
} from "../contracts/blob-errors.ts";
import { BlobSignedUrls } from "../contracts/blob-signed-urls.ts";
import { blobConfigLayer } from "./blob-config-live.ts";
import { BlobSignedUrlsLive } from "./blob-signed-urls-live.ts";

const rwToken = "vercel_blob_rw_12345fakeStoreId_30FakeRandomCharacters12345678";

// Port of the SDK's signed-token.presignurl.test-helpers.ts (api-blob's `createDelegationToken`).
const createDelegationToken = (payload: Record<string, unknown>, secret: string): string => {
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(segment, "utf8").digest("base64url");
  return `${segment}.${signature}`;
};

const deriveClientSigningToken = (secret: string, delegationToken: string): string =>
  createHmac("sha256", secret).update(delegationToken, "utf8").digest("base64url");

/** Runs `use` with `BlobSignedUrls` whose API URL is the test server's. */
const withSignedUrls = <A, E>(
  use: (
    signedUrls: BlobSignedUrls["Service"],
    serverUrl: string,
  ) => Effect.Effect<A, E, TestHttpServer>,
) =>
  Effect.gen(function* () {
    const server = yield* TestHttpServer;
    const layer = BlobSignedUrlsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          blobConfigLayer({ token: rwToken, apiUrl: `${server.url}/api/blob`, retries: 0 }),
          FetchHttpClient.layer,
          vercelOidcFromToken(Redacted.make("unused-oidc-token")),
        ),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );
    const signedUrls = yield* Effect.service(BlobSignedUrls).pipe(Effect.provide(layer));
    return yield* use(signedUrls, server.url);
  }).pipe(Effect.provide(TestHttpServerLive()));

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const enqueue = (...responses: ReadonlyArray<ReturnType<typeof json>>) =>
  Effect.flatMap(Effect.service(TestHttpServer), (server) => server.enqueue(...responses));

const requests = Effect.flatMap(Effect.service(TestHttpServer), (server) => server.requests);

describe("BlobSignedUrls.issueSignedToken", () => {
  it.effect("posts the SDK's body and decodes the token", () =>
    withSignedUrls((signedUrls) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_700_000_000_000);
        yield* enqueue(
          json(200, {
            delegationToken: "delegation",
            clientSigningToken: "secret",
            validUntil: 1_700_000_600_000,
          }),
        );
        const token = yield* signedUrls.issueSignedToken({
          allowedContentTypes: ["image/*"],
          maximumSizeInBytes: 1024,
          validUntil: DateTime.makeUnsafe(1_700_000_600_000),
          operations: ["get", "put", "get", "head"],
          pathname: "media/photo.png",
        });
        assert.strictEqual(token.delegationToken, "delegation");
        assert.isTrue(Redacted.isRedacted(token.clientSigningToken));
        assert.strictEqual(Redacted.value(token.clientSigningToken), "secret");
        assert.strictEqual(DateTime.toEpochMillis(token.validUntil), 1_700_000_600_000);

        const [request] = yield* requests;
        assert.strictEqual(request?.method, "POST");
        assert.strictEqual(request?.url, "/api/blob/signed-token");
        assert.strictEqual(
          request?.text,
          '{"pathname":"media/photo.png","operations":["get","put","head"],"validUntil":1700000600000,"maximumSizeInBytes":1024,"allowedContentTypes":["image/*"]}',
        );
        assert.strictEqual(request?.headers["content-type"], "application/json");
        assert.strictEqual(request?.headers["authorization"], `Bearer ${rwToken}`);
        assert.strictEqual(request?.headers["x-vercel-blob-store-id"], "12345fakeStoreId");
        assert.strictEqual(request?.headers["x-api-version"], "13");
      }),
    ),
  );

  it.effect("sends an empty body without options", () =>
    withSignedUrls((signedUrls) =>
      Effect.gen(function* () {
        yield* enqueue(json(200, { delegationToken: "d", clientSigningToken: "s", validUntil: 1 }));
        yield* signedUrls.issueSignedToken();
        const [request] = yield* requests;
        assert.strictEqual(request?.text, "{}");
      }),
    ),
  );

  it.effect("rejects a validUntil that is not in the future without a request", () =>
    withSignedUrls((signedUrls) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(5_000);
        const error = yield* Effect.flip(
          signedUrls.issueSignedToken({ validUntil: DateTime.makeUnsafe(5_000) }),
        );
        assert.instanceOf(error, VercelApiError);
        assert.instanceOf(error.reason, ApiBadRequest);
        assert.strictEqual(
          error.reason.message,
          "`issueSignedToken`: validUntil must be in the future.",
        );
        assert.deepStrictEqual(yield* requests, []);
      }),
    ),
  );

  it.effect("maps error bodies and unexpected responses", () =>
    withSignedUrls((signedUrls) =>
      Effect.gen(function* () {
        yield* enqueue(
          json(403, { error: { code: "forbidden", message: "nope" } }),
          json(404, { error: { code: "store_not_found" } }),
          json(200, { delegationToken: "d" }),
        );
        const forbidden = yield* Effect.flip(signedUrls.issueSignedToken());
        assert.instanceOf(forbidden, VercelApiError);
        assert.instanceOf(forbidden.reason, ApiForbidden);
        assert.deepStrictEqual(forbidden.errorCode, Option.some("forbidden"));

        const store = yield* Effect.flip(signedUrls.issueSignedToken());
        assert.instanceOf(store, BlobStoreUnavailable);
        assert.instanceOf(store.reason, BlobStoreNotFound);

        const unexpected = yield* Effect.flip(signedUrls.issueSignedToken());
        assert.instanceOf(unexpected, VercelApiError);
        assert.instanceOf(unexpected.reason, ApiUnexpectedResponse);
      }),
    ),
  );
});

describe("BlobSignedUrls.presign", () => {
  const secret = randomBytes(32).toString("base64");
  const tokenFor = (scope: Record<string, unknown>): SigningToken => {
    const delegationToken = createDelegationToken(
      { storeId: "store_abc", ownerId: "o", iat: 0, ...scope },
      secret,
    );
    return {
      delegationToken,
      clientSigningToken: Redacted.make(deriveClientSigningToken(secret, delegationToken)),
    };
  };

  it.effect("reads the current time from Clock", () =>
    withSignedUrls((signedUrls) =>
      Effect.gen(function* () {
        const token = tokenFor({ pathname: "a", operations: ["get"], validUntil: 10_000 });
        yield* TestClock.setTime(9_000);
        const payload = yield* signedUrls.presign(token, {
          operation: "get",
          pathname: "a",
          validUntil: DateTime.makeUnsafe(9_500),
        });
        assert.deepStrictEqual(payload.params, { "vercel-blob-valid-until": "9500" });

        yield* TestClock.setTime(10_001);
        const error = yield* Effect.flip(
          signedUrls.presign(token, { operation: "get", pathname: "a" }),
        );
        assert.strictEqual(
          error.message,
          "The signed delegation has expired; issue a new token first.",
        );
      }),
    ),
  );

  it.effect("builds Blob API URLs for put and delete, and blob URLs for head", () =>
    withSignedUrls((signedUrls, serverUrl) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const token = tokenFor({
          pathname: "*",
          operations: ["put", "delete", "head"],
          validUntil: 10_000,
        });
        const put = yield* signedUrls.presignUrl(token, {
          operation: "put",
          pathname: "folder/a b.png",
          access: "public",
          addRandomSuffix: false,
        });
        assert.strictEqual(`${put.origin}${put.pathname}`, `${serverUrl}/api/blob/`);
        assert.strictEqual(put.searchParams.get("pathname"), "folder/a b.png");
        assert.strictEqual(put.searchParams.get("vercel-blob-add-random-suffix"), "false");
        assert.strictEqual(put.searchParams.get("vercel-blob-delegation"), token.delegationToken);
        assert.match(put.searchParams.get("vercel-blob-signature") ?? "", /^[A-Za-z0-9_-]+$/);

        const del = yield* signedUrls.presignUrl(token, {
          operation: "delete",
          pathname: "a.png",
          access: "private",
        });
        assert.strictEqual(del.searchParams.get("pathname"), "a.png");
        assert.notStrictEqual(
          del.searchParams.get("vercel-blob-signature"),
          put.searchParams.get("vercel-blob-signature"),
        );

        const head = yield* signedUrls.presignUrl(token, {
          operation: "head",
          pathname: "a.png",
          access: "private",
        });
        assert.strictEqual(head.hostname, "abc.private.blob.vercel-storage.com");
        assert.isNull(head.searchParams.get("cache"));
      }),
    ),
  );
});

// Port of the SDK's get.node.test.ts.
describe("BlobSignedUrls.presignUrl (get)", () => {
  const storeId = "s".repeat(16);
  const blobSigningSecret = randomBytes(32).toString("base64");
  const now = Date.now();

  const makeSignedToken = (pathname: string): SigningToken => {
    const delegationToken = createDelegationToken(
      {
        storeId: `store_${storeId}`,
        ownerId: "owner_1",
        pathname,
        operations: ["get"],
        validUntil: now + 3600_000,
        iat: now,
      },
      blobSigningSecret,
    );
    return {
      delegationToken,
      clientSigningToken: Redacted.make(
        deriveClientSigningToken(blobSigningSecret, delegationToken),
      ),
    };
  };

  const atNow = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.andThen(TestClock.setTime(now), effect);

  it.effect(
    "builds a private object URL from pathname using storeId from the delegation token",
    () =>
      withSignedUrls((signedUrls) =>
        atNow(
          Effect.gen(function* () {
            const pathname = "media/photo.png";
            const token = makeSignedToken(pathname);
            const options = { operation: "get", pathname, access: "private" } as const;
            const url = yield* signedUrls.presignUrl(token, options);
            const again = yield* signedUrls.presignUrl(token, options);
            assert.strictEqual(url.href, again.href);
            assert.strictEqual(url.hostname, `${storeId}.private.blob.vercel-storage.com`);
            assert.strictEqual(url.pathname, `/${pathname}`);
            assert.strictEqual(
              url.searchParams.get("vercel-blob-delegation"),
              token.delegationToken,
            );
            assert.match(url.searchParams.get("vercel-blob-signature") ?? "", /^[A-Za-z0-9_-]+$/);
          }),
        ),
      ),
  );

  it.effect("builds a public object URL when access is public", () =>
    withSignedUrls((signedUrls) =>
      atNow(
        Effect.gen(function* () {
          const pathname = "a.png";
          const url = yield* signedUrls.presignUrl(makeSignedToken(pathname), {
            operation: "get",
            pathname,
            access: "public",
          });
          assert.strictEqual(url.hostname, `${storeId}.public.blob.vercel-storage.com`);
        }),
      ),
    ),
  );

  it.effect("keeps an explicit https blob URL as the base and merges existing query params", () =>
    withSignedUrls((signedUrls) =>
      atNow(
        Effect.gen(function* () {
          const logical = "nested/file.bin";
          const pathname = `https://${storeId}.private.blob.vercel-storage.com/${logical}?existing=1`;
          const token = makeSignedToken(pathname);
          const options = { operation: "get", pathname, access: "private" } as const;
          const url = yield* signedUrls.presignUrl(token, options);
          const again = yield* signedUrls.presignUrl(token, options);
          assert.strictEqual(url.href, again.href);
          assert.strictEqual(url.searchParams.get("existing"), "1");
          assert.match(url.searchParams.get("vercel-blob-signature") ?? "", /^[A-Za-z0-9_-]+$/);
          assert.strictEqual(
            `${url.origin}${url.pathname}`,
            `https://${storeId}.private.blob.vercel-storage.com/${logical}`,
          );
        }),
      ),
    ),
  );

  it.effect("treats http:// blob URLs as a full URL base", () =>
    withSignedUrls((signedUrls) =>
      atNow(
        Effect.gen(function* () {
          const pathname = `http://${storeId}.private.blob.vercel-storage.com/x.txt`;
          const token = makeSignedToken(pathname);
          const url = yield* signedUrls.presignUrl(token, {
            operation: "get",
            pathname,
            access: "private",
          });
          assert.strictEqual(url.protocol, "http:");
          assert.strictEqual(url.searchParams.get("vercel-blob-delegation"), token.delegationToken);
        }),
      ),
    ),
  );

  it.effect("appends cache=0 when useCache is false on a private blob", () =>
    withSignedUrls((signedUrls) =>
      atNow(
        Effect.gen(function* () {
          const pathname = "media/photo.png";
          const token = makeSignedToken(pathname);
          const url = yield* signedUrls.presignUrl(token, {
            operation: "get",
            pathname,
            access: "private",
            useCache: false,
          });
          assert.strictEqual(url.searchParams.get("cache"), "0");

          // cache is not part of the signed payload: the signature is identical.
          const withoutBypass = yield* signedUrls.presignUrl(token, {
            operation: "get",
            pathname,
            access: "private",
          });
          assert.isNull(withoutBypass.searchParams.get("cache"));
          assert.strictEqual(
            url.searchParams.get("vercel-blob-signature"),
            withoutBypass.searchParams.get("vercel-blob-signature"),
          );
        }),
      ),
    ),
  );

  it.effect("does not append cache=0 when useCache is true or omitted", () =>
    withSignedUrls((signedUrls) =>
      atNow(
        Effect.gen(function* () {
          const pathname = "media/photo.png";
          const url = yield* signedUrls.presignUrl(makeSignedToken(pathname), {
            operation: "get",
            pathname,
            access: "private",
            useCache: true,
          });
          assert.isNull(url.searchParams.get("cache"));
        }),
      ),
    ),
  );

  it.effect(
    "ignores useCache: false for public blobs (CDN only supports the bypass for private)",
    () =>
      withSignedUrls((signedUrls) =>
        atNow(
          Effect.gen(function* () {
            const pathname = "a.png";
            const url = yield* signedUrls.presignUrl(makeSignedToken(pathname), {
              operation: "get",
              pathname,
              access: "public",
              useCache: false,
            });
            assert.isNull(url.searchParams.get("cache"));
          }),
        ),
      ),
  );

  it.effect("rejects an invalid delegation token", () =>
    withSignedUrls((signedUrls) =>
      atNow(
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            signedUrls.presignUrl(
              { delegationToken: "not-a-jwt", clientSigningToken: Redacted.make("Zm9v") },
              { operation: "get", pathname: "a.png", access: "private" },
            ),
          );
          assert.instanceOf(error, BlobPresignFailed);
          assert.strictEqual(error.message, "Invalid or unreadable `delegationToken` payload.");
        }),
      ),
    ),
  );
});
