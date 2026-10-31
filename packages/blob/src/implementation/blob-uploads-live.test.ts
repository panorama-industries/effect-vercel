import { assert, describe, it } from "@effect/vitest";
import { VercelSystemEnvLive } from "@panorama-industries/effect-vercel-core";
import {
  Cause,
  ConfigProvider,
  DateTime,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import type { UploadCompleted } from "../contracts/blob-domain.ts";
import type { BlobConfigOptions } from "./blob-config-live.ts";

import { ETag, UploadRequest } from "../contracts/blob-domain.ts";
import {
  BlobPresignFailed,
  BlobReadWriteTokenRequired,
  BlobUploadEventRejected,
  EventMalformed,
  SignatureInvalid,
  SignatureMissing,
  WebhookPublicKeyMissing,
} from "../contracts/blob-errors.ts";
import { BlobUploads } from "../contracts/blob-uploads.ts";
import {
  callbackUrlUndeterminedWarning,
  callbackUrlUnhandledWarning,
} from "../internal/callback.ts";
import { getPayloadFromClientToken } from "../internal/client-token.ts";
import { blobConfigLayer } from "./blob-config-live.ts";
import { BlobUploadsLive } from "./blob-uploads-live.ts";

const rwToken = "vercel_blob_rw_12345fakeStoreId_30FakeRandomCharacters12345678";

/** 2023-01-01T00:00:00Z, the SDK tests' fake clock. */
const sdkNow = Date.parse("2023-01-01");

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

/** `BlobUploads` built from `vars` as the environment, like the SDK tests' `process.env`. */
const withUploads = <A, E>(
  use: (uploads: BlobUploads["Service"]) => Effect.Effect<A, E>,
  options: { readonly vars?: Record<string, string>; readonly config?: BlobConfigOptions } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(sdkNow);
    const layer = BlobUploadsLive.pipe(
      Layer.provide(
        Layer.mergeAll(blobConfigLayer(options.config ?? { token: rwToken }), VercelSystemEnvLive),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(options.vars ?? {}))),
    );
    return yield* use(yield* Effect.service(BlobUploads).pipe(Effect.provide(layer)));
  });

const webRequest = (
  body: unknown,
  options: { readonly url?: string; readonly headers?: Record<string, string> } = {},
) =>
  HttpServerRequest.fromWeb(
    new Request(options.url ?? "http://localhost:3000/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

/** Run a route handler against `request` and read its JSON response. */
const respond = <E>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest
  >,
  request: HttpServerRequest.HttpServerRequest,
) =>
  handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.flatMap((response) =>
      Effect.promise(
        () => HttpServerResponse.toWeb(response).json() as Promise<Record<string, unknown>>,
      ),
    ),
  );

const recordWarnings = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    const recorder = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    const value = yield* effect.pipe(Effect.provide(Logger.layer([recorder])));
    return { value, warnings: warnings.flat() };
  });

const generateEvent = (payload: Record<string, unknown>) => ({
  type: "blob.generate-client-token",
  payload: { multipart: false, clientPayload: null, ...payload },
});

const payloadOf = (response: Record<string, unknown>) =>
  Option.getOrThrow(getPayloadFromClientToken(String(response["clientToken"])));

const rejection = (error: unknown) => {
  assert.instanceOf(error, BlobUploadEventRejected);
  return error.reason;
};

const blob = {
  url: "https://store.public.blob.vercel-storage.com/newfile.txt",
  downloadUrl: "https://store.public.blob.vercel-storage.com/newfile.txt?download=1",
  pathname: "newfile.txt",
  contentType: "text/plain",
  contentDisposition: 'inline; filename="newfile.txt"',
  etag: '"etag"',
};

// Port of the SDK's client.node.test.ts and client.edge.test.ts.
describe("BlobUploads.generateClientToken", () => {
  it.effect("generates a client token", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const token = yield* uploads.generateClientToken({
          pathname: "foo.txt",
          onUploadCompleted: { callbackUrl: "https://example.com" },
        });
        assert.strictEqual(
          token,
          "vercel_blob_client_12345fakeStoreId_ZTVmZTJmYWZkOWJhMGNiNTVjOGExOWJkM2VhY2M5NzRhNzM4MmQ2NmEyN2EyMmYwMzFkMjQ0ZDIyMjMzN2Y0Yy5leUp3WVhSb2JtRnRaU0k2SW1admJ5NTBlSFFpTENKdmJsVndiRzloWkVOdmJYQnNaWFJsWkNJNmV5SmpZV3hzWW1GamExVnliQ0k2SW1oMGRIQnpPaTh2WlhoaGJYQnNaUzVqYjIwaWZTd2lkbUZzYVdSVmJuUnBiQ0k2TVRZM01qVXpNVEl6TURBd01IMD0=",
        );
        assert.deepStrictEqual(
          getPayloadFromClientToken(token),
          Option.some({
            pathname: "foo.txt",
            onUploadCompleted: { callbackUrl: "https://example.com" },
            validUntil: 1672531230000,
          }),
        );
      }),
    ),
  );

  it.effect("throws when ifMatch is used with allowOverwrite: false", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          // The types rule this out; the defect still guards untyped callers.
          // @ts-expect-error ifMatch implies overwriting
          uploads.generateClientToken({
            pathname: "foo.txt",
            ifMatch: ETag.make('"abc123"'),
            allowOverwrite: false,
          }),
        );
        assert.isTrue(Exit.hasDies(exit));
        assert.include(
          Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty),
          "ifMatch and allowOverwrite: false are contradictory. ifMatch is used for conditional overwrites, which requires allowOverwrite to be true.",
        );
      }),
    ),
  );

  it.effect("implicitly sets allowOverwrite when ifMatch is provided", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const token = yield* uploads.generateClientToken({
          pathname: "foo.txt",
          ifMatch: ETag.make('"abc123"'),
        });
        const payload = Option.getOrThrow(getPayloadFromClientToken(token));
        assert.strictEqual(payload.pathname, "foo.txt");
        assert.strictEqual(payload.ifMatch, '"abc123"');
        assert.strictEqual(payload.allowOverwrite, true);
      }),
    ),
  );

  it.effect("accepts a tokenPayload property", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const token = yield* uploads.generateClientToken({
          pathname: "foo.txt",
          onUploadCompleted: {
            callbackUrl: "https://example.com",
            tokenPayload: JSON.stringify({ foo: "bar" }),
          },
        });
        // Also the golden token of client.edge.test.ts.
        assert.strictEqual(
          token,
          "vercel_blob_client_12345fakeStoreId_N2I2NTAxOGI1Y2IwZDhlY2VlZGUyYTQ2YjE1ZmJhODRlYjU3M2Q5MjBlNjNiYmI4NmQ0ZTRhOTJhZmM1NTVjMi5leUp3WVhSb2JtRnRaU0k2SW1admJ5NTBlSFFpTENKdmJsVndiRzloWkVOdmJYQnNaWFJsWkNJNmV5SmpZV3hzWW1GamExVnliQ0k2SW1oMGRIQnpPaTh2WlhoaGJYQnNaUzVqYjIwaUxDSjBiMnRsYmxCaGVXeHZZV1FpT2lKN1hDSm1iMjljSWpwY0ltSmhjbHdpZlNKOUxDSjJZV3hwWkZWdWRHbHNJam94TmpjeU5UTXhNak13TURBd2ZRPT0=",
        );
        assert.deepStrictEqual(
          getPayloadFromClientToken(token),
          Option.some({
            pathname: "foo.txt",
            onUploadCompleted: {
              callbackUrl: "https://example.com",
              tokenPayload: '{"foo":"bar"}',
            },
            validUntil: 1672531230000,
          }),
        );
      }),
    ),
  );

  it.effect("serializes validUntil as epoch milliseconds in the caller's key order", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const token = yield* uploads.generateClientToken({
          validUntil: DateTime.makeUnsafe(1_800_000_000_000),
          pathname: "a.txt",
          maximumSizeInBytes: 10,
          allowedContentTypes: ["text/*"],
          cacheControlMaxAge: 60,
          addRandomSuffix: true,
        });
        const secured = Buffer.from(token.split("_")[4] ?? "", "base64").toString();
        assert.strictEqual(
          Buffer.from(secured.split(".")[1] ?? "", "base64").toString(),
          '{"validUntil":1800000000000,"pathname":"a.txt","maximumSizeInBytes":10,"allowedContentTypes":["text/*"],"cacheControlMaxAge":60,"addRandomSuffix":true}',
        );
        assert.strictEqual(
          secured.split(".")[0],
          createHmac("sha256", rwToken)
            .update(secured.split(".")[1] ?? "")
            .digest("hex"),
        );
      }),
    ),
  );

  it.effect("requires a read-write token", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(uploads.generateClientToken({ pathname: "a" }));
          assert.instanceOf(error, BlobReadWriteTokenRequired);
          assert.strictEqual(error.operation, "BlobUploads.generateClientToken");
        }),
      { config: { storeId: "store_oidc" } },
    ),
  );
});

describe("BlobUploads.handler", () => {
  it.effect("should return client token when called with blob.generate-client-token", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        let completed = 0;
        const response = yield* respond(
          uploads.handler({
            onBeforeGenerateToken: (request) =>
              Effect.succeed({
                tokenPayload: request.pathname,
                callbackUrl: "https://example.com",
              }),
            onUploadCompleted: () =>
              Effect.sync(() => {
                completed++;
              }),
          }),
          webRequest(generateEvent({ pathname: "newfile.txt" }), {
            headers: { "x-vercel-signature": "123" },
          }),
        );
        assert.deepStrictEqual(response, {
          type: "blob.generate-client-token",
          clientToken:
            "vercel_blob_client_12345fakeStoreId_Y2JhNTlmNWM3MmZmMGZmM2I2YzVlYzgwNTU3MDgwMWE1YTA4ZGU2MjIyNTFkNjRiYTI1NjVjNmRjYmFkYmQ5Yy5leUowYjJ0bGJsQmhlV3h2WVdRaU9pSnVaWGRtYVd4bExuUjRkQ0lzSW5CaGRHaHVZVzFsSWpvaWJtVjNabWxzWlM1MGVIUWlMQ0p2YmxWd2JHOWhaRU52YlhCc1pYUmxaQ0k2ZXlKallXeHNZbUZqYTFWeWJDSTZJbWgwZEhCek9pOHZaWGhoYlhCc1pTNWpiMjBpTENKMGIydGxibEJoZVd4dllXUWlPaUp1WlhkbWFXeGxMblI0ZENKOUxDSjJZV3hwWkZWdWRHbHNJam94TmpjeU5UTTBPREF3TURBd2ZRPT0=",
        });
        assert.strictEqual(completed, 0);
        assert.deepStrictEqual(payloadOf(response), {
          tokenPayload: "newfile.txt",
          onUploadCompleted: { callbackUrl: "https://example.com", tokenPayload: "newfile.txt" },
          pathname: "newfile.txt",
          validUntil: 1672534800000,
        });
      }),
    ),
  );

  it.effect("should run onCompleted when called with blob.upload-completed", () => {
    const token = "vercel_blob_client_123456789_TEST_TOKEN";
    const body = {
      type: "blob.upload-completed",
      payload: { blob, tokenPayload: "custom-metadata" },
    };
    const signature = createHmac("sha256", token).update(JSON.stringify(body)).digest("hex");
    return withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const events: Array<UploadCompleted> = [];
          const response = yield* respond(
            uploads.handler({
              onBeforeGenerateToken: (request) =>
                Effect.succeed({
                  tokenPayload: request.pathname,
                  callbackUrl: "https://example.com/upload-completed",
                }),
              onUploadCompleted: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            }),
            // Pretty-printed: the signature covers JSON.stringify(JSON.parse(body)).
            webRequest(JSON.stringify(body, null, 2), {
              headers: { "x-vercel-signature": signature },
            }),
          );
          assert.deepStrictEqual(response, { response: "ok", type: "blob.upload-completed" });
          assert.strictEqual(events.length, 1);
          assert.strictEqual(events[0]?.blob.pathname, "newfile.txt");
          assert.strictEqual(events[0]?.blob.url.href, blob.url);
          assert.strictEqual(events[0]?.blob.etag, '"etag"');
          assert.deepStrictEqual(events[0]?.tokenPayload, Option.some("custom-metadata"));
        }),
      { config: { token } },
    );
  });

  it.effect("uses clientPayload for tokenPayload by default", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const response = yield* respond(
          uploads.handler({
            onBeforeGenerateToken: () =>
              Effect.succeed({ addRandomSuffix: false, callbackUrl: "https://example.com" }),
            onUploadCompleted: () => Effect.void,
          }),
          webRequest(
            generateEvent({
              pathname: "newfile.txt",
              clientPayload: "custom-metadata-from-client",
            }),
            { headers: { "x-vercel-signature": "123" } },
          ),
        );
        assert.strictEqual(
          response["clientToken"],
          "vercel_blob_client_12345fakeStoreId_NThhZGE3YTVkODBjNTcxMmIyMzJlMTAzMDM3MTgwYzI5NzVlMjUzYjhkYzU4MzFkZTZjMzk4ZmEwNmY2ODI5Ny5leUpoWkdSU1lXNWtiMjFUZFdabWFYZ2lPbVpoYkhObExDSndZWFJvYm1GdFpTSTZJbTVsZDJacGJHVXVkSGgwSWl3aWIyNVZjR3h2WVdSRGIyMXdiR1YwWldRaU9uc2lZMkZzYkdKaFkydFZjbXdpT2lKb2RIUndjem92TDJWNFlXMXdiR1V1WTI5dElpd2lkRzlyWlc1UVlYbHNiMkZrSWpvaVkzVnpkRzl0TFcxbGRHRmtZWFJoTFdaeWIyMHRZMnhwWlc1MEluMHNJblpoYkdsa1ZXNTBhV3dpT2pFMk56STFNelE0TURBd01EQjk=",
        );
        assert.deepStrictEqual(payloadOf(response), {
          addRandomSuffix: false,
          onUploadCompleted: {
            callbackUrl: "https://example.com",
            tokenPayload: "custom-metadata-from-client",
          },
          pathname: "newfile.txt",
          validUntil: 1672534800000,
        });
      }),
    ),
  );

  it.effect("provides `clientPayload` in onBeforeGenerateToken", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const seen: Array<UploadRequest> = [];
        yield* respond(
          uploads.handler({
            onBeforeGenerateToken: (request) =>
              Effect.sync(() => {
                seen.push(request);
                return { addRandomSuffix: false, callbackUrl: "https://example.com" };
              }),
            onUploadCompleted: () => Effect.void,
          }),
          webRequest(
            generateEvent({
              pathname: "newfile.txt",
              clientPayload: "custom-metadata-from-client-we-expect",
            }),
          ),
        );
        assert.deepStrictEqual(seen, [
          new UploadRequest({
            pathname: "newfile.txt",
            clientPayload: Option.some("custom-metadata-from-client-we-expect"),
            multipart: false,
          }),
        ]);
      }),
    ),
  );

  it.effect("ignores client callbackUrl when server provides one", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const serverCallbackUrl = "https://server-controlled.example.com/callback";
        const maliciousClientCallbackUrl = "https://malicious.com/steal-data";
        const response = yield* respond(
          uploads.handler({
            onBeforeGenerateToken: () => Effect.succeed({ callbackUrl: serverCallbackUrl }),
            onUploadCompleted: () => Effect.void,
          }),
          webRequest(
            generateEvent({ pathname: "test.txt", callbackUrl: maliciousClientCallbackUrl }),
          ),
        );
        assert.strictEqual(response["type"], "blob.generate-client-token");
        const payload = payloadOf(response);
        assert.strictEqual(payload.onUploadCompleted?.callbackUrl, serverCallbackUrl);
        assert.notInclude(JSON.stringify(payload), maliciousClientCallbackUrl);
        // The SDK signs `tokenPayload: clientPayload ?? null` into the callback.
        assert.isNull(payload.onUploadCompleted?.tokenPayload);
      }),
    ),
  );

  it.effect("ignores client callbackUrl even if server doesn't provide one", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const maliciousClientCallbackUrl = "https://malicious-site.com/steal-data";
        const response = yield* respond(
          uploads.handler({
            onBeforeGenerateToken: () => Effect.succeed({ addRandomSuffix: false }),
            onUploadCompleted: () => Effect.void,
          }),
          webRequest(
            generateEvent({ pathname: "test.txt", callbackUrl: maliciousClientCallbackUrl }),
          ),
        );
        assert.strictEqual(response["type"], "blob.generate-client-token");
        const payload = payloadOf(response);
        assert.isUndefined(payload.onUploadCompleted);
        assert.notInclude(JSON.stringify(payload), maliciousClientCallbackUrl);
      }),
    ),
  );

  it.effect("should make onUploadCompleted optional", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const response = yield* respond(
          uploads.handler({
            onBeforeGenerateToken: () => Effect.succeed({ addRandomSuffix: false }),
          }),
          webRequest(generateEvent({ pathname: "newfile.txt" })),
        );
        assert.strictEqual(response["type"], "blob.generate-client-token");
      }),
    ),
  );

  const callbackUrlOf = (vars: Record<string, string>, url: string) =>
    withUploads(
      (uploads) =>
        respond(
          uploads.handler({
            onBeforeGenerateToken: () => Effect.succeed({ addRandomSuffix: false }),
            onUploadCompleted: () => Effect.void,
          }),
          webRequest(generateEvent({ pathname: "newfile.txt" }), { url }),
        ).pipe(Effect.map((response) => payloadOf(response).onUploadCompleted?.callbackUrl)),
      { vars },
    );

  it.effect(
    "should generate automatic callbackUrl when on Vercel and onUploadCompleted provided",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* callbackUrlOf(
            {
              VERCEL: "1",
              VERCEL_ENV: "preview",
              VERCEL_BRANCH_URL: "branch-abc-123.vercel.app",
            },
            "http://localhost:3000/api/upload",
          ),
          "https://branch-abc-123.vercel.app/api/upload",
        );
      }),
  );

  it.effect("should use VERCEL_BLOB_CALLBACK_URL when provided", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callbackUrlOf(
          { VERCEL_BLOB_CALLBACK_URL: "https://custom-callback.example.com" },
          "http://localhost:3000/api/upload",
        ),
        "https://custom-callback.example.com/api/upload",
      );
    }),
  );

  it.effect("should warn when callbackUrl provided but onUploadCompleted not defined", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const { value, warnings } = yield* recordWarnings(
          respond(
            uploads.handler({
              onBeforeGenerateToken: () =>
                Effect.succeed({
                  addRandomSuffix: false,
                  callbackUrl: "https://example.com/callback",
                }),
            }),
            webRequest(generateEvent({ pathname: "newfile.txt" })),
          ),
        );
        assert.deepStrictEqual(warnings, [callbackUrlUnhandledWarning]);
        // As in the SDK, the URL is still signed into the token.
        assert.strictEqual(
          payloadOf(value).onUploadCompleted?.callbackUrl,
          "https://example.com/callback",
        );
      }),
    ),
  );

  it.effect(
    "should warn when onUploadCompleted provided but no callbackUrl can be determined",
    () =>
      withUploads(
        (uploads) =>
          Effect.gen(function* () {
            const { value, warnings } = yield* recordWarnings(
              respond(
                uploads.handler({
                  onBeforeGenerateToken: () => Effect.succeed({ addRandomSuffix: false }),
                  onUploadCompleted: () => Effect.void,
                }),
                webRequest(generateEvent({ pathname: "newfile.txt" })),
              ),
            );
            assert.deepStrictEqual(warnings, [callbackUrlUndeterminedWarning]);
            assert.isUndefined(payloadOf(value).onUploadCompleted);
          }),
        { vars: { NODE_ENV: "test" } },
      ),
  );

  it.effect("should handle blob.upload-completed without onUploadCompleted", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const response = yield* respond(
            uploads.handler({
              onBeforeGenerateToken: (request) =>
                Effect.succeed({
                  tokenPayload: request.pathname,
                  callbackUrl: "https://example.com/upload-completed",
                }),
            }),
            webRequest(
              {
                type: "blob.upload-completed",
                payload: { blob: { pathname: "newfile.txt" }, tokenPayload: "custom-metadata" },
              },
              {
                // The SDK's golden signature.
                headers: {
                  "x-vercel-signature":
                    "a4eac582498d4548d701eb8ff3e754f33f078e75298b9a1a0cdbac128981b28d",
                },
              },
            ),
          );
          assert.deepStrictEqual(response, { response: "ok", type: "blob.upload-completed" });
        }),
      { config: { token: "vercel_blob_client_123456789_TEST_TOKEN" } },
    ),
  );

  it.effect("should generate correct callbackUrl with full URL in request", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callbackUrlOf(
          {
            VERCEL: "1",
            VERCEL_ENV: "preview",
            VERCEL_BRANCH_URL: "branch-abc-123.vercel.app",
          },
          "http://localhost:3000/api/upload?test=1",
        ),
        "https://branch-abc-123.vercel.app/api/upload?test=1",
      );
    }),
  );

  it.effect("should generate correct callbackUrl with relative URL in request", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callbackUrlOf(
          {
            VERCEL: "1",
            VERCEL_ENV: "production",
            VERCEL_PROJECT_PRODUCTION_URL: "myapp.vercel.app",
          },
          "http://localhost:3000/api/upload?example=test",
        ),
        "https://myapp.vercel.app/api/upload?example=test",
      );
    }),
  );

  it.effect("should use VERCEL_BLOB_CALLBACK_URL with query params preserved", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callbackUrlOf(
          { VERCEL_BLOB_CALLBACK_URL: "https://webhook.example.com" },
          "http://localhost:3000/api/upload?userId=123&type=avatar",
        ),
        "https://webhook.example.com/api/upload?userId=123&type=avatar",
      );
    }),
  );

  it.effect("should generate callbackUrl for production environment on Vercel", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callbackUrlOf(
          {
            VERCEL: "1",
            VERCEL_ENV: "production",
            VERCEL_PROJECT_PRODUCTION_URL: "myapp.vercel.app",
          },
          "http://localhost:3000/api/blob/upload",
        ),
        "https://myapp.vercel.app/api/blob/upload",
      );
    }),
  );

  it.effect("should fallback to VERCEL_URL when VERCEL_BRANCH_URL is missing in preview", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callbackUrlOf(
          {
            VERCEL: "1",
            VERCEL_ENV: "preview",
            VERCEL_URL: "myapp-git-feature-user.vercel.app",
          },
          "http://localhost:3000/api/upload",
        ),
        "https://myapp-git-feature-user.vercel.app/api/upload",
      );
    }),
  );

  // Beyond the SDK suite.

  it.effect("keeps a route's validUntil and constraints, in the route's key order", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const response = yield* respond(
          uploads.handler({
            onBeforeGenerateToken: () =>
              Effect.succeed({
                validUntil: DateTime.makeUnsafe(1_700_000_000_000),
                ifMatch: ETag.make('"e"'),
                maximumSizeInBytes: 5,
              }),
          }),
          webRequest(generateEvent({ pathname: "a.txt", multipart: true })),
        );
        assert.deepStrictEqual(payloadOf(response), {
          validUntil: 1_700_000_000_000,
          ifMatch: '"e"',
          maximumSizeInBytes: 5,
          pathname: "a.txt",
          allowOverwrite: true,
        });
      }),
    ),
  );

  it.effect("lets errors of the route's callbacks through", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(
          respond(
            uploads.handler({ onBeforeGenerateToken: () => Effect.fail(new Unauthorized()) }),
            webRequest(generateEvent({ pathname: "a.txt" })),
          ),
        );
        assert.instanceOf(refused, Unauthorized);

        const body = { type: "blob.upload-completed", payload: { blob } };
        const failed = yield* Effect.flip(
          respond(
            uploads.handler({
              onBeforeGenerateToken: () => Effect.succeed({}),
              onUploadCompleted: () => Effect.fail(new Unauthorized()),
            }),
            webRequest(body, {
              headers: {
                "x-vercel-signature": createHmac("sha256", rwToken)
                  .update(JSON.stringify(body))
                  .digest("hex"),
              },
            }),
          ),
        );
        assert.instanceOf(failed, Unauthorized);
      }),
    ),
  );

  it.effect("rejects callbacks without a valid signature", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const route = uploads.handler({
          onBeforeGenerateToken: () => Effect.succeed({}),
          onUploadCompleted: () => Effect.void,
        });
        const body = { type: "blob.upload-completed", payload: { blob } };
        const missing = yield* Effect.flip(respond(route, webRequest(body)));
        assert.instanceOf(rejection(missing), SignatureMissing);
        const invalid = yield* Effect.flip(
          respond(route, webRequest(body, { headers: { "x-vercel-signature": "123" } })),
        );
        assert.instanceOf(rejection(invalid), SignatureInvalid);
      }),
    ),
  );

  it.effect("rejects malformed events", () =>
    withUploads((uploads) =>
      Effect.gen(function* () {
        const route = uploads.handler({
          onBeforeGenerateToken: () => Effect.succeed({}),
          onUploadCompleted: () => Effect.void,
        });
        const messageOf = (body: unknown, headers?: Record<string, string>) =>
          Effect.flip(respond(route, webRequest(body, headers ? { headers } : {}))).pipe(
            Effect.map((error) => {
              const reason = rejection(error);
              assert.instanceOf(reason, EventMalformed);
              return reason.message;
            }),
          );
        assert.strictEqual(yield* messageOf("not json"), "The request body is not JSON.");
        assert.strictEqual(
          yield* messageOf({ type: "blob.generate-presigned-url", payload: {} }),
          "Invalid event type",
        );
        assert.isString(yield* messageOf({ type: "blob.generate-client-token", payload: {} }));

        const incomplete = { type: "blob.upload-completed", payload: { blob: { pathname: "a" } } };
        assert.isString(
          yield* messageOf(incomplete, {
            "x-vercel-signature": createHmac("sha256", rwToken)
              .update(JSON.stringify(incomplete))
              .digest("hex"),
          }),
        );
      }),
    ),
  );

  it.effect("requires a read-write token", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            respond(
              uploads.handler({ onBeforeGenerateToken: () => Effect.succeed({}) }),
              webRequest(generateEvent({ pathname: "a" })),
            ),
          );
          assert.instanceOf(error, BlobReadWriteTokenRequired);
        }),
      { config: { storeId: "oidcStore" } },
    ),
  );
});

describe("BlobUploads.presignedHandler", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const webhookPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
  const ed25519Hex = (text: string) =>
    Buffer.from(sign(null, Buffer.from(text, "utf8"), privateKey)).toString("hex");

  const secret = randomBytes(32).toString("base64");
  const signingToken = (operations: ReadonlyArray<string>) => {
    const segment = Buffer.from(
      JSON.stringify({
        storeId: "store_abc",
        ownerId: "o",
        pathname: "*",
        operations,
        validUntil: sdkNow + 3600_000,
        iat: sdkNow,
      }),
    ).toString("base64url");
    const delegationToken = `${segment}.${createHmac("sha256", secret).update(segment).digest("base64url")}`;
    return {
      delegationToken,
      clientSigningToken: Redacted.make(
        createHmac("sha256", secret).update(delegationToken).digest("base64url"),
      ),
    };
  };
  const unusedToken = signingToken(["put"]);

  const oidcConfig = (overrides: BlobConfigOptions = {}) => ({
    config: { storeId: "store_abc", webhookPublicKey, ...overrides },
  });

  it.effect(
    "runs onCompleted when Ed25519 x-vercel-signature verifies against BLOB webhook public key",
    () =>
      withUploads(
        (uploads) =>
          Effect.gen(function* () {
            const events: Array<UploadCompleted> = [];
            const body = {
              type: "blob.upload-completed",
              payload: { blob, tokenPayload: "custom-metadata" },
            };
            const response = yield* respond(
              uploads.presignedHandler({
                getSignedToken: () => Effect.succeed({ token: unusedToken, urlOptions: {} }),
                onUploadCompleted: (event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
              }),
              webRequest(body, {
                headers: { "x-vercel-signature": ed25519Hex(JSON.stringify(body)) },
              }),
            );
            assert.deepStrictEqual(response, { response: "ok", type: "blob.upload-completed" });
            assert.strictEqual(events[0]?.blob.pathname, "newfile.txt");
            assert.deepStrictEqual(events[0]?.tokenPayload, Option.some("custom-metadata"));
          }),
        oidcConfig(),
      ),
  );

  it.effect("rejects webhook when Ed25519 signature does not verify", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const body = {
            type: "blob.upload-completed",
            payload: { blob, tokenPayload: "custom-metadata" },
          };
          const wrongSignature = ed25519Hex(
            JSON.stringify({ ...body, payload: { ...body.payload, forged: true } }),
          );
          const error = yield* Effect.flip(
            respond(
              uploads.presignedHandler({
                getSignedToken: () => Effect.succeed({ token: unusedToken }),
                onUploadCompleted: () => Effect.void,
              }),
              webRequest(body, { headers: { "x-vercel-signature": wrongSignature } }),
            ),
          );
          assert.instanceOf(rejection(error), SignatureInvalid);
        }),
      oidcConfig(),
    ),
  );

  it.effect("rejects HMAC-shaped signatures (must be hex Ed25519, 128 chars)", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            respond(
              uploads.presignedHandler({
                getSignedToken: () => Effect.succeed({ token: unusedToken }),
                onUploadCompleted: () => Effect.void,
              }),
              webRequest(
                { type: "blob.upload-completed", payload: { blob: { pathname: "x" } } },
                {
                  headers: {
                    "x-vercel-signature":
                      "a4eac582498d4548d701eb8ff3e754f33f078e75298b9a1a0cdbac128981b28d",
                  },
                },
              ),
            ),
          );
          assert.instanceOf(rejection(error), SignatureInvalid);
        }),
      oidcConfig(),
    ),
  );

  it.effect("resolves callback URL and passes it to presign when onUploadCompleted is set", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const token = signingToken(["put"]);
          const seen: Array<UploadRequest> = [];
          const response = yield* respond(
            uploads.presignedHandler({
              getSignedToken: (request) =>
                Effect.sync(() => {
                  seen.push(request);
                  return { token, urlOptions: {} };
                }),
              onUploadCompleted: () => Effect.void,
            }),
            webRequest(
              {
                type: "blob.generate-presigned-url",
                payload: { pathname: "a.png", clientPayload: "cp", multipart: false },
              },
              { url: "http://localhost:3000/vercel/blob/api/app/handle-blob-upload-presigned" },
            ),
          );
          assert.deepStrictEqual(seen, [
            new UploadRequest({
              pathname: "a.png",
              clientPayload: Option.some("cp"),
              multipart: false,
            }),
          ]);
          const callbackUrl =
            "https://callback-base.example.com/vercel/blob/api/app/handle-blob-upload-presigned";
          const canonical = [
            "operation=put",
            "pathname=a.png",
            "vercel-blob-callback-token-payload=cp",
            `vercel-blob-callback-url=${callbackUrl}`,
          ].join("\n");
          assert.deepStrictEqual(response, {
            type: "blob.generate-presigned-url",
            presignedUrlPayload: {
              delegationToken: token.delegationToken,
              signature: createHmac("sha256", Redacted.value(token.clientSigningToken))
                .update(canonical)
                .digest("base64url"),
              params: {
                "vercel-blob-callback-url": callbackUrl,
                "vercel-blob-callback-token-payload": "cp",
              },
            },
          });
        }),
      {
        vars: { VERCEL_BLOB_CALLBACK_URL: "https://callback-base.example.com" },
        config: { storeId: "store_abc", webhookPublicKey: "test-webhook-public-key" },
      },
    ),
  );

  // Beyond the SDK suite.

  it.effect("signs the route's urlOptions and its tokenPayload over the clientPayload", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const response = yield* respond(
            uploads.presignedHandler({
              getSignedToken: () =>
                Effect.succeed({
                  token: signingToken(["put"]),
                  urlOptions: {
                    callbackUrl: "https://route.example.com/cb",
                    tokenPayload: "server",
                    addRandomSuffix: true,
                    maximumSizeInBytes: 10,
                  },
                }),
              onUploadCompleted: () => Effect.void,
            }),
            webRequest({
              type: "blob.generate-presigned-url",
              payload: { pathname: "a.png", clientPayload: "client", multipart: true },
            }),
          );
          const payload = response["presignedUrlPayload"] as { params: Record<string, string> };
          assert.deepStrictEqual(payload.params, {
            "vercel-blob-maximum-size-in-bytes": "10",
            "vercel-blob-add-random-suffix": "true",
            "vercel-blob-callback-url": "https://route.example.com/cb",
            "vercel-blob-callback-token-payload": "server",
          });
        }),
      oidcConfig(),
    ),
  );

  it.effect("fails with BlobPresignFailed when the token cannot sign the upload", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            respond(
              uploads.presignedHandler({
                getSignedToken: () => Effect.succeed({ token: signingToken(["get"]) }),
              }),
              webRequest({
                type: "blob.generate-presigned-url",
                payload: { pathname: "a.png", clientPayload: null, multipart: false },
              }),
            ),
          );
          assert.instanceOf(error, BlobPresignFailed);
        }),
      oidcConfig(),
    ),
  );

  it.effect("requires a webhook public key", () =>
    withUploads(
      (uploads) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            respond(
              uploads.presignedHandler({
                getSignedToken: () => Effect.succeed({ token: unusedToken }),
              }),
              webRequest({
                type: "blob.generate-presigned-url",
                payload: { pathname: "a.png", clientPayload: null, multipart: false },
              }),
            ),
          );
          assert.instanceOf(rejection(error), WebhookPublicKeyMissing);
        }),
      { config: { storeId: "store_abc" } },
    ),
  );
});
