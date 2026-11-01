import type { HttpClient } from "effect/http";

import { VercelOidcLive, VercelSystemEnvLive } from "@panorama-industries/effect-vercel-core";
import { Config, Effect, Layer } from "effect";

import type { BlobSignedUrls } from "../contracts/blob-signed-urls.ts";
import type { BlobStore } from "../contracts/blob-store.ts";
import type { BlobUploads } from "../contracts/blob-uploads.ts";
import type { BlobConfigOptions } from "./blob-config-live.ts";

import { blobConfigLayer } from "./blob-config-live.ts";
import { BlobSignedUrlsLive } from "./blob-signed-urls-live.ts";
import { BlobStoreLive } from "./blob-store-live.ts";
import { BlobUploadsLive } from "./blob-uploads-live.ts";

/**
 * Store, signed URLs and upload routes, with the given values taking precedence over the Vercel
 * environment (see `blobConfigLayer`). Provides Vercel OIDC and the system environment itself, so
 * only an `HttpClient` is left to provide, e.g. `FetchHttpClient.layer`.
 *
 * Compose the individual layers instead to refresh OIDC tokens in local development
 * (`VercelOidcRefreshingLive`).
 */
export const blobLayer = (
  options: BlobConfigOptions = {},
): Layer.Layer<
  BlobStore | BlobSignedUrls | BlobUploads,
  Config.ConfigError,
  HttpClient.HttpClient
> =>
  Layer.mergeAll(BlobStoreLive, BlobSignedUrlsLive, BlobUploadsLive).pipe(
    Layer.provide(Layer.mergeAll(blobConfigLayer(options), VercelOidcLive, VercelSystemEnvLive)),
  );

/**
 * {@link blobLayer} with its options read from `Config`, either one `Config` of the options or a
 * record of a `Config` per option, e.g. `blobLayerConfig({ token: Config.Redacted("MY_TOKEN") })`.
 */
export const blobLayerConfig = (
  options: Config.Wrap<BlobConfigOptions>,
): Layer.Layer<
  BlobStore | BlobSignedUrls | BlobUploads,
  Config.ConfigError,
  HttpClient.HttpClient
> => Layer.unwrap(Effect.map(Config.unwrap(options), blobLayer));

/**
 * {@link blobLayer} configured from the Vercel environment alone (`BLOB_READ_WRITE_TOKEN`, or the
 * function's OIDC token with `BLOB_STORE_ID`).
 */
export const BlobLive: Layer.Layer<
  BlobStore | BlobSignedUrls | BlobUploads,
  Config.ConfigError,
  HttpClient.HttpClient
> = blobLayer();
