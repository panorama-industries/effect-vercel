import type { Config } from "effect";
import type { HttpClient } from "effect/http";

import { VercelOidcLive, VercelSystemEnvLive } from "@panorama-industries/effect-vercel-core";
import { Layer } from "effect";

import type { BlobSignedUrls } from "../contracts/blob-signed-urls.ts";
import type { BlobStore } from "../contracts/blob-store.ts";
import type { BlobUploads } from "../contracts/blob-uploads.ts";

import { BlobConfigLive } from "./blob-config-live.ts";
import { BlobSignedUrlsLive } from "./blob-signed-urls-live.ts";
import { BlobStoreLive } from "./blob-store-live.ts";
import { BlobUploadsLive } from "./blob-uploads-live.ts";

/**
 * Store, signed URLs and upload routes configured from the Vercel environment
 * (`BLOB_READ_WRITE_TOKEN`, or the function's OIDC token with `BLOB_STORE_ID`). Provide an
 * `HttpClient`, e.g. `FetchHttpClient.layer`.
 *
 * Compose the individual layers instead to override configuration (`blobConfigLayer`) or to
 * refresh OIDC tokens in local development (`VercelOidcRefreshingLive`).
 */
export const BlobLive: Layer.Layer<
  BlobStore | BlobSignedUrls | BlobUploads,
  Config.ConfigError,
  HttpClient.HttpClient
> = Layer.mergeAll(BlobStoreLive, BlobSignedUrlsLive, BlobUploadsLive).pipe(
  Layer.provide(Layer.mergeAll(BlobConfigLive, VercelOidcLive, VercelSystemEnvLive)),
);
