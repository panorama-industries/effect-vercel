import type { TestHttpResponse } from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import { Config, ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { BlobSignedUrls } from "../contracts/blob-signed-urls.ts";
import { BlobStore } from "../contracts/blob-store.ts";
import { BlobUploads } from "../contracts/blob-uploads.ts";
import { blobLayer, blobLayerConfig } from "./blob-live.ts";

const token = "vercel_blob_rw_12345fakeStoreId_30FakeRandomCharacters12345678";

const emptyPage: TestHttpResponse = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ blobs: [], hasMore: false }),
};

const withEnv = (vars: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars)));

// Lists through the layer with nothing but an `HttpClient` provided, and returns the request the
// test server saw.
const listThrough = <E>(
  layer: Layer.Layer<BlobStore | BlobSignedUrls | BlobUploads, E, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const server = yield* TestHttpServer;
    yield* server.enqueue(emptyPage);
    yield* Effect.gen(function* () {
      yield* BlobSignedUrls;
      yield* BlobUploads;
      yield* (yield* BlobStore).list();
    }).pipe(Effect.provide(layer.pipe(Layer.provide(FetchHttpClient.layer))));
    const [request] = yield* server.requests;
    assert.isDefined(request);
    return request!;
  });

describe("blobLayer", () => {
  it.effect("provides every service from the given options", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const request = yield* listThrough(
        blobLayer({ token, apiUrl: `${server.url}/api/blob`, retries: 0 }),
      );
      assert.strictEqual(request.url, "/api/blob");
      assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
    }).pipe(Effect.provide(TestHttpServerLive()), withEnv({})),
  );
});

describe("blobLayerConfig", () => {
  it.effect("reads a Config per option", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const request = yield* listThrough(
        blobLayerConfig({
          token: Config.Redacted("MY_BLOB_TOKEN"),
          apiUrl: Config.succeed(`${server.url}/api/blob`),
          retries: Config.succeed(0),
        }),
      );
      assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
    }).pipe(Effect.provide(TestHttpServerLive()), withEnv({ MY_BLOB_TOKEN: token })),
  );

  it.effect("reads one Config of all the options", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const request = yield* listThrough(
        blobLayerConfig(
          Config.all({
            token: Config.String("MY_BLOB_TOKEN"),
            apiUrl: Config.succeed(`${server.url}/api/blob`),
            retries: Config.succeed(0),
          }),
        ),
      );
      assert.strictEqual(request.headers.authorization, `Bearer ${token}`);
    }).pipe(Effect.provide(TestHttpServerLive()), withEnv({ MY_BLOB_TOKEN: token })),
  );

  it.effect("fails with a ConfigError when an option's variable is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Layer.build(
          blobLayerConfig({ token: Config.Redacted("MY_BLOB_TOKEN") }).pipe(
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      );
      assert.instanceOf(error, Config.ConfigError);
    }).pipe(Effect.scoped, withEnv({ BLOB_READ_WRITE_TOKEN: token })),
  );
});
