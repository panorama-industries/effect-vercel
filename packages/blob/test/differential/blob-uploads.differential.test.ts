import { assert, describe, it } from "@effect/vitest";
import * as sdkClient from "@vercel/blob/client";
import { DateTime, Effect, Option, Redacted } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

import type {
  PresignedUploadAuthorization,
  UploadAuthorization,
} from "../../src/contracts/blob-uploads.ts";
import type { Outcome, Setup } from "./harness.ts";

import { ETag } from "../../src/contracts/blob-domain.ts";
import { BlobUploads } from "../../src/contracts/blob-uploads.ts";
import { BlobUploadsLive } from "../../src/implementation/blob-uploads-live.ts";
import {
  differential,
  ourOutcome,
  putResponse,
  readWriteToken,
  sdkOutcome,
  storeId,
  withoutTag,
} from "./harness.ts";

/** Fixed time of every comparison; the SDK's own golden vectors use 2023-01-01. */
const now = Date.parse("2023-01-01T00:00:00.000Z");

const keys = generateKeyPairSync("ed25519");
const webhookPublicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();

const callbackBase = "https://callback.example.com";

const setup: Setup = {
  auth: "readWrite",
  env: { VERCEL_BLOB_CALLBACK_URL: callbackBase, BLOB_WEBHOOK_PUBLIC_KEY: webhookPublicKey },
};

const run = (runSetup: Setup = setup) => differential(BlobUploadsLive, runSetup);

const utc = (millis: number) => DateTime.makeUnsafe(millis);

/** Run an SDK call with `Date` frozen at {@link now}. */
const atFixedTime = <A>(call: () => Promise<A>): Promise<A> => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  return call().finally(() => vi.useRealTimers());
};

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  vi.restoreAllMocks();
});

const decodeClientToken = (token: string) => {
  const encoded = token.split("_")[4] ?? "";
  const [signature, payload] = Buffer.from(encoded, "base64").toString().split(".");
  return {
    signature,
    payload: JSON.parse(Buffer.from(payload ?? "", "base64").toString()) as unknown,
  };
};

describe("differential: @vercel/blob@2.8.2 vs BlobUploadsLive", () => {
  describe("generateClientToken at a fixed time", () => {
    const cases: ReadonlyArray<
      readonly [
        string,
        Omit<sdkClient.GenerateClientTokenOptions, "token">,
        Parameters<BlobUploads["Service"]["generateClientToken"]>[0],
      ]
    > = [
      [
        "callback only (SDK golden vector)",
        { pathname: "foo.txt", onUploadCompleted: { callbackUrl: "https://example.com" } },
        { pathname: "foo.txt", onUploadCompleted: { callbackUrl: "https://example.com" } },
      ],
      [
        "callback with tokenPayload (SDK golden vector)",
        {
          pathname: "foo.txt",
          onUploadCompleted: { callbackUrl: "https://example.com", tokenPayload: '{"foo":"bar"}' },
        },
        {
          pathname: "foo.txt",
          onUploadCompleted: { callbackUrl: "https://example.com", tokenPayload: '{"foo":"bar"}' },
        },
      ],
      ["pathname only", { pathname: "a b/ü.txt" }, { pathname: "a b/ü.txt" }],
      [
        "every constraint",
        {
          pathname: "foo.txt",
          maximumSizeInBytes: 1024,
          allowedContentTypes: ["image/*", "text/plain"],
          validUntil: now + 60_000,
          addRandomSuffix: true,
          allowOverwrite: true,
          cacheControlMaxAge: 3600,
          ifMatch: '"e1"',
          onUploadCompleted: { callbackUrl: "https://example.com/cb", tokenPayload: "t" },
        },
        {
          pathname: "foo.txt",
          maximumSizeInBytes: 1024,
          allowedContentTypes: ["image/*", "text/plain"],
          validUntil: utc(now + 60_000),
          addRandomSuffix: true,
          allowOverwrite: true,
          cacheControlMaxAge: 3600,
          ifMatch: ETag.make('"e1"'),
          onUploadCompleted: { callbackUrl: "https://example.com/cb", tokenPayload: "t" },
        },
      ],
      [
        "ifMatch implies allowOverwrite",
        { pathname: "foo.txt", ifMatch: '"e1"' },
        { pathname: "foo.txt", ifMatch: ETag.make('"e1"') },
      ],
      [
        "allowOverwrite false and addRandomSuffix false",
        { pathname: "foo.txt", allowOverwrite: false, addRandomSuffix: false },
        { pathname: "foo.txt", allowOverwrite: false, addRandomSuffix: false },
      ],
    ];

    it.effect("produces byte-identical client tokens", () =>
      Effect.gen(function* () {
        const uploads = yield* BlobUploads;
        yield* TestClock.setTime(now);
        for (const [name, sdkOptions, ourOptions] of cases) {
          const sdkToken = yield* Effect.promise(() =>
            atFixedTime(() => sdkClient.generateClientTokenFromReadWriteToken({ ...sdkOptions })),
          );
          const ourToken = yield* uploads.generateClientToken(ourOptions);
          assert.deepStrictEqual(decodeClientToken(ourToken), decodeClientToken(sdkToken), name);
          assert.strictEqual(ourToken, sdkToken, name);
        }
      }).pipe(run()),
    );

    it.effect("reproduces the SDK's golden vector", () =>
      Effect.gen(function* () {
        const uploads = yield* BlobUploads;
        yield* TestClock.setTime(now);
        assert.strictEqual(
          yield* uploads.generateClientToken({
            pathname: "foo.txt",
            onUploadCompleted: { callbackUrl: "https://example.com" },
          }),
          "vercel_blob_client_12345fakeStoreId_ZTVmZTJmYWZkOWJhMGNiNTVjOGExOWJkM2VhY2M5NzRhNzM4MmQ2NmEyN2EyMmYwMzFkMjQ0ZDIyMjMzN2Y0Yy5leUp3WVhSb2JtRnRaU0k2SW1admJ5NTBlSFFpTENKdmJsVndiRzloWkVOdmJYQnNaWFJsWkNJNmV5SmpZV3hzWW1GamExVnliQ0k2SW1oMGRIQnpPaTh2WlhoaGJYQnNaUzVqYjIwaWZTd2lkbUZzYVdSVmJuUnBiQ0k2TVRZM01qVXpNVEl6TURBd01IMD0=",
        );
      }).pipe(run()),
    );
  });

  /** A web `Request` to the upload route, as both handlers receive it. */
  const routeRequest = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://app.example.com/api/upload?route=1", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  /** Run our handler on `request` and read the JSON it answers. */
  const respond = <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    request: Request,
  ) =>
    handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.flatMap((response) =>
        Effect.promise(async () => {
          const web = HttpServerResponse.toWeb(response);
          return { status: web.status, body: (await web.json()) as unknown };
        }),
      ),
    );

  describe("handler vs handleUpload", () => {
    type Authorization = Record<string, unknown>;

    const generateBoth = (
      payload: { pathname: string; clientPayload: string | null; multipart: boolean },
      sdkAuthorization: Authorization,
      ourAuthorization: UploadAuthorization,
      withCallback: boolean,
    ) =>
      Effect.gen(function* () {
        const uploads = yield* BlobUploads;
        const body = { type: "blob.generate-client-token" as const, payload };
        const sdkSeen: Array<unknown> = [];
        const ourSeen: Array<unknown> = [];
        const sdk = yield* sdkOutcome(
          () =>
            atFixedTime(() =>
              sdkClient.handleUpload({
                body,
                request: routeRequest(JSON.stringify(body)),
                onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
                  sdkSeen.push({ pathname, clientPayload, multipart });
                  return { ...sdkAuthorization };
                },
                ...(withCallback ? { onUploadCompleted: async () => undefined } : {}),
              }),
            ),
          (result) => result,
        );
        const ours = yield* ourOutcome(
          respond(
            uploads.handler({
              onBeforeGenerateToken: (request) =>
                Effect.sync(() => {
                  ourSeen.push({
                    pathname: request.pathname,
                    clientPayload: Option.getOrNull(request.clientPayload),
                    multipart: request.multipart,
                  });
                  return ourAuthorization;
                }),
              ...(withCallback ? { onUploadCompleted: () => Effect.void } : {}),
            }),
            routeRequest(JSON.stringify(body)),
          ),
          (response) => response.body,
        );
        return { sdk, ours, sdkSeen, ourSeen };
      });

    const assertGenerated = (
      result: Effect.Success<ReturnType<typeof generateBoth>>,
      name: string,
    ) => {
      assert.property(result.sdk, "ok", `${name}: the SDK failed`);
      assert.deepStrictEqual(result.ourSeen, result.sdkSeen, `${name}: callback arguments`);
      const token = (outcome: Outcome<unknown>) =>
        "ok" in outcome
          ? decodeClientToken((outcome.ok as { clientToken: string }).clientToken)
          : outcome;
      assert.deepStrictEqual(token(withoutTag(result.ours)), token(result.sdk), `${name}: payload`);
      assert.deepStrictEqual(withoutTag(result.ours), result.sdk, name);
    };

    it.effect("answers blob.generate-client-token with identical tokens", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const payload = {
          pathname: "newfile.txt",
          clientPayload: "custom-metadata",
          multipart: false,
        };
        assertGenerated(
          yield* generateBoth(payload, {}, {}, false),
          "no callback, default validUntil",
        );
        assertGenerated(
          yield* generateBoth(payload, {}, {}, true),
          "callback derived from VERCEL_BLOB_CALLBACK_URL",
        );
        assertGenerated(
          yield* generateBoth(
            payload,
            { tokenPayload: "server-payload", callbackUrl: "https://example.com/cb" },
            { tokenPayload: "server-payload", callbackUrl: "https://example.com/cb" },
            true,
          ),
          "explicit callback and tokenPayload",
        );
        assertGenerated(
          yield* generateBoth(
            { pathname: "a.png", clientPayload: null, multipart: true },
            {
              allowedContentTypes: ["image/*"],
              maximumSizeInBytes: 100,
              validUntil: now + 5000,
              addRandomSuffix: true,
              cacheControlMaxAge: 60,
              ifMatch: '"e1"',
            },
            {
              allowedContentTypes: ["image/*"],
              maximumSizeInBytes: 100,
              validUntil: utc(now + 5000),
              addRandomSuffix: true,
              cacheControlMaxAge: 60,
              ifMatch: ETag.make('"e1"'),
            },
            true,
          ),
          "every constraint, null clientPayload, multipart",
        );
        assertGenerated(
          yield* generateBoth(
            payload,
            { callbackUrl: "https://example.com/cb" },
            { callbackUrl: "https://example.com/cb" },
            false,
          ),
          "callbackUrl without onUploadCompleted",
        );
      }).pipe(run()),
    );

    it.effect("derives no callback URL outside Vercel without VERCEL_BLOB_CALLBACK_URL", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        assertGenerated(
          yield* generateBoth(
            { pathname: "f.txt", clientPayload: null, multipart: false },
            {},
            {},
            true,
          ),
          "no callback",
        );
      }).pipe(run({ auth: "readWrite" })),
    );

    it.effect("derives the preview branch URL on Vercel", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        assertGenerated(
          yield* generateBoth(
            { pathname: "f.txt", clientPayload: "p", multipart: false },
            {},
            {},
            true,
          ),
          "preview",
        );
      }).pipe(
        run({
          auth: "readWrite",
          env: {
            VERCEL: "1",
            VERCEL_ENV: "preview",
            VERCEL_BRANCH_URL: "branch.example.vercel.app",
            VERCEL_URL: "deployment.example.vercel.app",
          },
        }),
      ),
    );

    it.effect("derives the production URL on Vercel", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        assertGenerated(
          yield* generateBoth(
            { pathname: "f.txt", clientPayload: "p", multipart: false },
            {},
            {},
            true,
          ),
          "production",
        );
      }).pipe(
        run({
          auth: "readWrite",
          env: {
            VERCEL: "1",
            VERCEL_ENV: "production",
            VERCEL_PROJECT_PRODUCTION_URL: "app.example.com",
          },
        }),
      ),
    );

    const completedBody = {
      type: "blob.upload-completed" as const,
      payload: { blob: putResponse("newfile.txt"), tokenPayload: "custom-metadata" },
    };

    const completeBoth = (rawBody: string, signature: string | undefined) =>
      Effect.gen(function* () {
        const uploads = yield* BlobUploads;
        const sdkSeen: Array<unknown> = [];
        const ourSeen: Array<unknown> = [];
        const headers: Record<string, string> =
          signature === undefined ? {} : { "x-vercel-signature": signature };
        const sdk = yield* sdkOutcome(
          () =>
            sdkClient.handleUpload({
              body: JSON.parse(rawBody) as sdkClient.HandleUploadBody,
              request: routeRequest(rawBody, headers),
              onBeforeGenerateToken: async () => ({}),
              onUploadCompleted: async (payload) => {
                sdkSeen.push({ ...payload, blob: { ...payload.blob } });
              },
            }),
          (result) => result,
        );
        const ours = yield* ourOutcome(
          respond(
            uploads.handler({
              onBeforeGenerateToken: () => Effect.succeed({}),
              onUploadCompleted: (event) =>
                Effect.sync(() => {
                  ourSeen.push({
                    blob: {
                      url: event.blob.url.href,
                      downloadUrl: event.blob.downloadUrl.href,
                      pathname: event.blob.pathname,
                      contentType: event.blob.contentType,
                      contentDisposition: event.blob.contentDisposition,
                      etag: event.blob.etag,
                    },
                    tokenPayload: Option.getOrNull(event.tokenPayload),
                  });
                }),
            }),
            routeRequest(rawBody, headers),
          ),
          (response) => response.body,
        );
        return { sdk, ours, sdkSeen, ourSeen };
      });

    const hmac = (body: string) => createHmac("sha256", readWriteToken).update(body).digest("hex");

    it.live("accepts a correctly signed blob.upload-completed like the SDK", () =>
      Effect.gen(function* () {
        const raw = JSON.stringify(completedBody);
        const result = yield* completeBoth(raw, hmac(raw));
        assert.deepStrictEqual(result.sdk, {
          ok: { type: "blob.upload-completed", response: "ok" },
        });
        assert.deepStrictEqual(withoutTag(result.ours), result.sdk);
        assert.deepStrictEqual(result.ourSeen, result.sdkSeen);
      }).pipe(run()),
    );

    it.live("verifies the signature over the re-serialized JSON, like the SDK", () =>
      Effect.gen(function* () {
        const raw = JSON.stringify(completedBody, null, 2);
        const result = yield* completeBoth(raw, hmac(JSON.stringify(completedBody)));
        assert.property(result.sdk, "ok");
        assert.deepStrictEqual(withoutTag(result.ours), result.sdk);
      }).pipe(run()),
    );

    it.live("rejects missing and invalid signatures like the SDK", () =>
      Effect.gen(function* () {
        const raw = JSON.stringify(completedBody);
        for (const [name, signature, tag] of [
          ["missing", undefined, "BlobUploadEventRejected/SignatureMissing"],
          ["wrong", hmac(`${raw} `), "BlobUploadEventRejected/SignatureInvalid"],
          [
            "keyed with another token",
            createHmac("sha256", "other").update(raw).digest("hex"),
            "BlobUploadEventRejected/SignatureInvalid",
          ],
        ] as const) {
          const result = yield* completeBoth(raw, signature);
          assert.property(result.sdk, "error", name);
          assert.deepStrictEqual(withoutTag(result.ours), result.sdk, name);
          assert.strictEqual(result.ours.tag, tag, name);
          assert.deepStrictEqual(result.sdkSeen, [], name);
          assert.deepStrictEqual(result.ourSeen, [], name);
        }
      }).pipe(run()),
    );

    it.live("both refuse without a read-write token", () =>
      Effect.gen(function* () {
        const raw = JSON.stringify(completedBody);
        const result = yield* completeBoth(raw, hmac(raw));
        assert.property(result.sdk, "error");
        assert.deepStrictEqual(withoutTag(result.ours), result.sdk);
        assert.strictEqual(result.ours.tag, "BlobReadWriteTokenRequired");
      }).pipe(run({ auth: "oidc", readWriteToken: false, env: setup.env })),
    );
  });

  describe("presignedHandler vs handleUploadPresigned", () => {
    const signingSecret = "presigned-secret";
    const delegationPayload = Buffer.from(
      JSON.stringify({
        storeId,
        ownerId: "team_1",
        pathname: "*",
        operations: ["put"],
        validUntil: now + 3_600_000,
        iat: now,
        maximumSizeInBytes: 10_000,
      }),
    ).toString("base64url");
    const delegationToken = `${delegationPayload}.${createHmac("sha256", signingSecret)
      .update(delegationPayload)
      .digest("base64url")}`;
    const clientSigningToken = createHmac("sha256", signingSecret)
      .update(delegationToken)
      .digest("base64url");
    const sdkToken = { delegationToken, clientSigningToken, validUntil: now + 3_600_000 };
    const ourToken = { delegationToken, clientSigningToken: Redacted.make(clientSigningToken) };

    const generateBoth = (
      payload: { pathname: string; clientPayload: string | null; multipart: boolean },
      sdkUrlOptions: Record<string, unknown> | undefined,
      ourUrlOptions: PresignedUploadAuthorization["urlOptions"],
      withCallback: boolean,
    ) =>
      Effect.gen(function* () {
        const uploads = yield* BlobUploads;
        const body = { type: "blob.generate-presigned-url" as const, payload };
        const sdk = yield* sdkOutcome(
          () =>
            atFixedTime(() =>
              sdkClient.handleUploadPresigned({
                body,
                request: routeRequest(JSON.stringify(body)),
                getSignedToken: async () =>
                  sdkUrlOptions === undefined
                    ? { token: sdkToken }
                    : { token: sdkToken, urlOptions: { ...sdkUrlOptions } },
                ...(withCallback ? { onUploadCompleted: async () => undefined } : {}),
              }),
            ),
          (result) => result,
        );
        const ours = yield* ourOutcome(
          respond(
            uploads.presignedHandler({
              getSignedToken: () =>
                Effect.succeed(
                  ourUrlOptions === undefined
                    ? { token: ourToken }
                    : { token: ourToken, urlOptions: ourUrlOptions },
                ),
              ...(withCallback ? { onUploadCompleted: () => Effect.void } : {}),
            }),
            routeRequest(JSON.stringify(body)),
          ),
          (response) => response.body,
        );
        return { sdk, ours };
      });

    it.effect("answers blob.generate-presigned-url with identical payloads", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const payload = { pathname: "uploads/a.png", clientPayload: "client", multipart: false };
        const cases = [
          ["no options, no callback", undefined, undefined, false],
          ["derived callback with clientPayload", undefined, undefined, true],
          [
            "every option",
            {
              allowedContentTypes: ["image/png"],
              maximumSizeInBytes: 500,
              validUntil: now + 60_000,
              allowOverwrite: true,
              addRandomSuffix: true,
              cacheControlMaxAge: 120,
              ifMatch: '"e1"',
              callbackUrl: "https://example.com/done",
              tokenPayload: "server",
            },
            {
              allowedContentTypes: ["image/png"],
              maximumSizeInBytes: 500,
              validUntil: utc(now + 60_000),
              allowOverwrite: true,
              addRandomSuffix: true,
              cacheControlMaxAge: 120,
              ifMatch: ETag.make('"e1"'),
              callbackUrl: "https://example.com/done",
              tokenPayload: "server",
            },
            true,
          ],
        ] as const;
        for (const [name, sdkOptions, ourOptions, withCallback] of cases) {
          const result = yield* generateBoth(payload, sdkOptions, ourOptions, withCallback);
          assert.property(result.sdk, "ok", `${name}: the SDK failed`);
          assert.deepStrictEqual(withoutTag(result.ours), result.sdk, name);
        }
        const nullPayload = yield* generateBoth(
          { pathname: "a.png", clientPayload: null, multipart: true },
          undefined,
          undefined,
          true,
        );
        assert.deepStrictEqual(withoutTag(nullPayload.ours), nullPayload.sdk, "null clientPayload");
        const refused = yield* generateBoth(
          payload,
          { maximumSizeInBytes: 20_000 },
          { maximumSizeInBytes: 20_000 },
          false,
        );
        assert.property(refused.sdk, "error");
        assert.deepStrictEqual(withoutTag(refused.ours), refused.sdk, "above the token's size");
      }).pipe(run()),
    );

    const completedBody = {
      type: "blob.upload-completed" as const,
      payload: { blob: putResponse("uploads/a.png", "image/png"), tokenPayload: null },
    };

    const completeBoth = (rawBody: string, signature: string | undefined) =>
      Effect.gen(function* () {
        const uploads = yield* BlobUploads;
        const headers: Record<string, string> =
          signature === undefined ? {} : { "x-vercel-signature": signature };
        const sdk = yield* sdkOutcome(
          () =>
            sdkClient.handleUploadPresigned({
              body: JSON.parse(rawBody) as sdkClient.HandleUploadPresignedBody,
              request: routeRequest(rawBody, headers),
              getSignedToken: async () => ({ token: sdkToken }),
              onUploadCompleted: async () => undefined,
            }),
          (result) => result,
        );
        const ours = yield* ourOutcome(
          respond(
            uploads.presignedHandler({
              getSignedToken: () => Effect.succeed({ token: ourToken }),
              onUploadCompleted: () => Effect.void,
            }),
            routeRequest(rawBody, headers),
          ),
          (response) => response.body,
        );
        return { sdk, ours };
      });

    const ed25519 = (body: string) =>
      sign(null, Buffer.from(body, "utf8"), keys.privateKey).toString("hex");

    it.live("accepts and rejects Ed25519 callback signatures like the SDK", () =>
      Effect.gen(function* () {
        const raw = JSON.stringify(completedBody);
        const accepted = yield* completeBoth(raw, ed25519(raw));
        assert.deepStrictEqual(accepted.sdk, {
          ok: { type: "blob.upload-completed", response: "ok" },
        });
        assert.deepStrictEqual(withoutTag(accepted.ours), accepted.sdk);
        const other = generateKeyPairSync("ed25519");
        for (const [name, signature] of [
          ["missing", undefined],
          ["tampered body", ed25519(`${raw} `)],
          ["other key", sign(null, Buffer.from(raw), other.privateKey).toString("hex")],
          ["not hex", "zz".repeat(64)],
          ["short", ed25519(raw).slice(0, 64)],
        ] as const) {
          const result = yield* completeBoth(raw, signature);
          assert.property(result.sdk, "error", name);
          assert.deepStrictEqual(withoutTag(result.ours), result.sdk, name);
        }
      }).pipe(run()),
    );

    it.live("both refuse without a webhook public key", () =>
      Effect.gen(function* () {
        const raw = JSON.stringify(completedBody);
        const result = yield* completeBoth(raw, ed25519(raw));
        assert.deepStrictEqual(result.sdk, { error: "BlobError(Missing webhook public key)" });
        assert.deepStrictEqual(withoutTag(result.ours), result.sdk);
        assert.strictEqual(result.ours.tag, "BlobUploadEventRejected/WebhookPublicKeyMissing");
      }).pipe(run({ auth: "readWrite" })),
    );
  });
});
