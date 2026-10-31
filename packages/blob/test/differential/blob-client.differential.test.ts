import type {
  TestHttpRequest,
  TestHttpResponse,
} from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import { TestHttpServer } from "@panorama-industries/effect-vercel-core/testing";
import * as sdkClient from "@vercel/blob/client";
import { Effect, Stream } from "effect";
import { afterAll, beforeAll, vi } from "vitest";

import type { ClientUploadOptions, UploadRouteOptions } from "../../src/contracts/blob-client.ts";
import type { BlobBody } from "../../src/contracts/blob-domain.ts";
import type { UploadProgress } from "../../src/contracts/blob-domain.ts";
import type { Comparison, Responder } from "./harness.ts";

import { BlobClient } from "../../src/contracts/blob-client.ts";
import { BlobPathname, ClientToken, PartNumber } from "../../src/contracts/blob-domain.ts";
import { BlobClientLive } from "../../src/implementation/blob-client-live.ts";
import {
  compare,
  differential,
  errorMapping,
  json,
  ourOutcome,
  ourPutResult,
  putResponse,
  readWriteSetup,
  sdkOutcome,
  sdkPutResult,
  storeId,
  withoutTag,
  assertSameProgress,
} from "./harness.ts";

const run = differential(BlobClientLive, readWriteSetup);

const pathname = BlobPathname.make("foo.txt");

/** Any token with the client prefix; the store parses only its store id. */
const clientToken = `vercel_blob_client_${storeId}_ZmFrZS1zaWduZWQtdG9rZW4=`;

const delegationToken = `${Buffer.from(
  JSON.stringify({ storeId, ownerId: "team_1", pathname: "*", operations: ["put"] }),
).toString("base64url")}.signature`;

const presignedUrlPayload = {
  delegationToken,
  signature: "c2lnbmF0dXJl",
  params: { "vercel-blob-valid-until": "1900000000000", "vercel-blob-allow-overwrite": "1" },
};

/** The application's upload route at `/api/upload` and the Blob API at `/api/blob`. */
const responder =
  (route: (request: TestHttpRequest) => TestHttpResponse = defaultRoute, api?: Responder) =>
  (request: TestHttpRequest): TestHttpResponse => {
    if (request.url.startsWith("/api/upload")) return route(request);
    if (api !== undefined) return typeof api === "function" ? api(request) : api;
    switch (request.headers["x-mpu-action"]) {
      case "create":
        return json({ key: "mpu-key", uploadId: "mpu-upload" });
      case "upload":
        return json({ etag: `"part-${request.headers["x-mpu-part-number"]}"` });
      default:
        return json(putResponse());
    }
  };

const defaultRoute = (request: TestHttpRequest): TestHttpResponse => {
  const event = JSON.parse(request.text) as { type: string };
  return event.type === "blob.generate-client-token"
    ? json({ type: event.type, clientToken })
    : json({ type: event.type, presignedUrlPayload });
};

const assertSame = (result: Comparison<unknown>, name = "") => {
  assert.isAbove(result.sdkRequests.length, 0, `${name}: the SDK sent no request`);
  assert.deepStrictEqual(result.ourRequests, result.sdkRequests, `${name}: requests differ`);
  assert.deepStrictEqual(withoutTag(result.ours), result.sdk, `${name}: outcomes differ`);
};

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

type Bodies = readonly [name: string, sdk: () => unknown, ours: () => BlobBody];

const encoder = new TextEncoder();

const bodies: ReadonlyArray<Bodies> = [
  ["string", () => "hello client", () => "hello client"],
  ["bytes", () => Buffer.from([0, 255, 10]), () => new Uint8Array([0, 255, 10])],
  [
    "Blob",
    () => new Blob(["blob"], { type: "text/csv" }),
    () => new Blob(["blob"], { type: "text/csv" }),
  ],
  [
    "stream",
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("chunk 1 "));
          controller.enqueue(encoder.encode("chunk 2"));
          controller.close();
        },
      }),
    () => Stream.fromIterable([encoder.encode("chunk 1 "), encoder.encode("chunk 2")]),
  ],
];

describe("differential: @vercel/blob@2.8.2 client vs BlobClientLive", () => {
  const uploadBoth = (
    method: "upload" | "uploadPresigned",
    sdkBody: () => unknown,
    ourBody: () => BlobBody,
    options: ClientUploadOptions & Omit<UploadRouteOptions, "handleUploadUrl">,
    respond: (request: TestHttpRequest) => TestHttpResponse = responder(),
  ) =>
    Effect.gen(function* () {
      const client = yield* BlobClient;
      const handleUploadUrl = `${(yield* TestHttpServer).url}/api/upload?route=1`;
      return yield* compare(
        respond,
        () =>
          sdkOutcome(
            () =>
              sdkClient[method](
                pathname,
                sdkBody() as string,
                {
                  ...options,
                  handleUploadUrl,
                } as sdkClient.UploadOptions,
              ),
            sdkPutResult,
          ),
        ourOutcome(
          client[method](pathname, ourBody(), { ...options, handleUploadUrl }),
          ourPutResult,
        ),
      );
    });

  describe("upload", () => {
    it.live("sends identical route and API requests for every body type", () =>
      Effect.gen(function* () {
        for (const [name, sdkBody, ourBody] of bodies) {
          assertSame(yield* uploadBoth("upload", sdkBody, ourBody, { access: "public" }), name);
        }
      }).pipe(run),
    );

    it.live("forwards clientPayload, route headers and contentType", () =>
      Effect.gen(function* () {
        assertSame(
          yield* uploadBoth(
            "upload",
            () => "x",
            () => "x",
            {
              access: "private",
              contentType: "text/x-custom",
              clientPayload: '{"form":1}',
              headers: { "x-csrf-token": "csrf", "content-type": "application/x-route" },
            },
          ),
        );
      }).pipe(run),
    );

    it.live("uploads in parts with multipart: true", () =>
      Effect.gen(function* () {
        const result = yield* uploadBoth(
          "upload",
          () => "small multipart",
          () => "small multipart",
          {
            access: "public",
            multipart: true,
          },
        );
        assertSame(result);
        assert.deepStrictEqual(
          result.sdkRequests.map((request) => request.headers["x-mpu-action"] ?? request.url),
          ["/api/upload?route=1", "create", "upload", "complete"],
        );
      }).pipe(run),
    );

    it.live("reports the same progress events", () =>
      Effect.gen(function* () {
        const client = yield* BlobClient;
        const handleUploadUrl = `${(yield* TestHttpServer).url}/api/upload`;
        const sdkEvents: Array<UploadProgress> = [];
        const ourEvents: Array<UploadProgress> = [];
        const body = "b".repeat(150 * 1024);
        const result = yield* compare(
          responder(),
          () =>
            sdkOutcome(async () => {
              const value = await sdkClient.upload(pathname, body, {
                access: "public",
                handleUploadUrl,
                onUploadProgress: (event) => sdkEvents.push({ ...event }),
              });
              await new Promise((resolve) => setTimeout(resolve, 250));
              return value;
            }, sdkPutResult),
          ourOutcome(
            client.upload(pathname, body, {
              access: "public",
              handleUploadUrl,
              onUploadProgress: (event) => Effect.sync(() => ourEvents.push({ ...event })),
            }),
            ourPutResult,
          ).pipe(Effect.tap(() => Effect.sleep("250 millis"))),
        );
        assertSame(result);
        assertSameProgress(ourEvents, sdkEvents);
      }).pipe(run),
    );

    it.live("fails like the SDK when the route does not authorize", () =>
      Effect.gen(function* () {
        const routes: ReadonlyArray<readonly [string, TestHttpResponse]> = [
          ["500", { status: 500, body: "nope" }],
          [
            "401 JSON",
            { status: 401, headers: { "content-type": "application/json" }, body: "{}" },
          ],
          ["200 not JSON", { status: 200, body: "not json" }],
        ];
        for (const [name, route] of routes) {
          const result = yield* uploadBoth(
            "upload",
            () => "x",
            () => "x",
            { access: "public" },
            responder(() => route),
          );
          assert.deepStrictEqual(result.ourRequests, result.sdkRequests, name);
          assert.strictEqual(result.sdkRequests.length, 1, `${name}: only the route was called`);
          assert.property(result.sdk, "error", name);
          assert.deepStrictEqual(withoutTag(result.ours), result.sdk, name);
          assert.strictEqual(result.ours.tag, "BlobUploadAuthorizationFailed", name);
        }
      }).pipe(run),
    );

    it.live("maps every API error code like the SDK", () =>
      Effect.gen(function* () {
        const declares = [
          "BlobStoreUnavailable",
          "BlobUploadRejected",
          "BlobPreconditionFailed",
          "BlobClientTokenNotAllowed",
        ];
        for (const row of errorMapping) {
          const result = yield* uploadBoth(
            "upload",
            () => "x",
            () => "x",
            { access: "public" },
            responder(defaultRoute, row.response),
          );
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
      }).pipe(run),
    );
  });

  describe("uploadPresigned", () => {
    it.live("sends identical route and presigned API requests for every body type", () =>
      Effect.gen(function* () {
        for (const [name, sdkBody, ourBody] of bodies) {
          const result = yield* uploadBoth("uploadPresigned", sdkBody, ourBody, {
            access: "public",
            clientPayload: "p",
          });
          assertSame(result, name);
          assert.isUndefined(result.sdkRequests[1]?.headers.authorization, name);
        }
      }).pipe(run),
    );

    it.live("uploads in presigned parts with multipart: true", () =>
      Effect.gen(function* () {
        assertSame(
          yield* uploadBoth(
            "uploadPresigned",
            () => "parts",
            () => "parts",
            {
              access: "private",
              multipart: true,
              contentType: "text/plain",
            },
          ),
        );
      }).pipe(run),
    );

    it.live("fails like the SDK when the route answers without a payload", () =>
      Effect.gen(function* () {
        for (const [name, route] of [
          ["500", { status: 500 }],
          ["no payload", json({ type: "blob.generate-presigned-url" })],
        ] as const) {
          const result = yield* uploadBoth(
            "uploadPresigned",
            () => "x",
            () => "x",
            { access: "public" },
            responder(() => route),
          );
          assert.deepStrictEqual(result.ourRequests, result.sdkRequests, name);
          assert.property(result.sdk, "error", name);
          assert.deepStrictEqual(withoutTag(result.ours), result.sdk, name);
        }
      }).pipe(run),
    );
  });

  describe("client-token primitives", () => {
    const token = ClientToken.make(clientToken);

    it.live("put with a client token sends identical requests", () =>
      Effect.gen(function* () {
        const client = yield* BlobClient;
        for (const [name, sdkBody, ourBody] of bodies) {
          assertSame(
            yield* compare(
              responder(),
              () =>
                sdkOutcome(
                  () =>
                    sdkClient.put(pathname, sdkBody() as string, {
                      access: "public",
                      token: clientToken,
                      contentType: "text/plain",
                    }),
                  sdkPutResult,
                ),
              ourOutcome(
                client.put(pathname, ourBody(), {
                  access: "public",
                  token,
                  contentType: "text/plain",
                }),
                ourPutResult,
              ),
            ),
            name,
          );
        }
      }).pipe(run),
    );

    it.live("manual multipart with a client token sends identical requests", () =>
      Effect.gen(function* () {
        const client = yield* BlobClient;
        const result = yield* compare(
          responder(),
          () =>
            sdkOutcome(
              async () => {
                const created = await sdkClient.createMultipartUpload(pathname, {
                  access: "private",
                  token: clientToken,
                  contentType: "text/plain",
                });
                // Our upload handle keeps `contentType`, so parts and completion resend it.
                const common = {
                  access: "private" as const,
                  token: clientToken,
                  contentType: "text/plain",
                  key: created.key,
                  uploadId: created.uploadId,
                };
                const part = await sdkClient.uploadPart(pathname, "part", {
                  ...common,
                  partNumber: 1,
                });
                const blob = await sdkClient.completeMultipartUpload(pathname, [part], common);
                return { part, blob: sdkPutResult(blob) };
              },
              (value) => value,
            ),
          ourOutcome(
            Effect.gen(function* () {
              const upload = yield* client.createMultipartUpload(pathname, {
                access: "private",
                token,
                contentType: "text/plain",
              });
              const part = yield* client.uploadPart(upload, PartNumber.make(1), "part", { token });
              const blob = yield* client.completeMultipartUpload(upload, [part], { token });
              return {
                part: { etag: part.etag, partNumber: part.partNumber as number },
                blob: ourPutResult(blob),
              };
            }),
            (value) => value,
          ),
        );
        assertSame(result);
      }).pipe(run),
    );
  });
});
