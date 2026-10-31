import type { Config } from "effect";

import { Effect, Layer, Option, Redacted } from "effect";

import type { BlobAccess, StoreId } from "../contracts/blob-domain.ts";

import { BlobAuth, BlobConfig } from "../contracts/blob-config.ts";
import { configError, env, requestEnv } from "../internal/env.ts";
import { parseStoreId, storeIdFromReadWriteToken } from "../internal/store-id.ts";
import { defaultBlobBaseUrl } from "../internal/urls.ts";

/** Values that replace what {@link BlobConfigLive} reads from the environment. */
export interface BlobConfigOptions {
  /**
   * Read-write token (`vercel_blob_rw_<storeId>_…`). Takes priority over OIDC and
   * `BLOB_READ_WRITE_TOKEN`, and becomes `readWriteToken`.
   */
  readonly token?: string | Redacted.Redacted<string> | undefined;

  /**
   * Store to address with the Vercel OIDC token, as `store_<id>` or `<id>`; replaces
   * `BLOB_STORE_ID`. Ignored when `token` is given.
   */
  readonly storeId?: string | undefined;

  /** Blob API base URL; replaces `VERCEL_BLOB_API_URL`, for an emulator or a test server. */
  readonly apiUrl?: URL | string | undefined;

  /** Extra headers for every API request, merged over the environment's. */
  readonly headers?: Readonly<Record<string, string>> | undefined;

  /** Retries after the first attempt; replaces `VERCEL_BLOB_RETRIES`. */
  readonly retries?: number | undefined;

  /** Where `get` reads a store's blobs; see `BlobConfig.blobBaseUrl`. */
  readonly blobBaseUrl?: ((storeId: StoreId, access: BlobAccess) => URL) | undefined;

  /** Ed25519 public key (PEM) for presigned-upload callbacks; replaces `BLOB_WEBHOOK_PUBLIC_KEY`. */
  readonly webhookPublicKey?: string | undefined;

  /** Origin for upload-completed callbacks; replaces `VERCEL_BLOB_CALLBACK_URL`. */
  readonly callbackBaseUrl?: string | undefined;
}

const noCredentials = configError(
  "No blob credentials found. Pass a `token` option, set `BLOB_READ_WRITE_TOKEN`, or use Vercel " +
    "OIDC with a `storeId` option or `BLOB_STORE_ID`.",
);

const invalidReadWriteToken = (source: string) =>
  configError(
    `Invalid ${source}: expected a read-write token of the form vercel_blob_rw_<storeId>_<secret>.`,
  );

const resolveBlobConfig = Effect.fnUntraced(function* (options: BlobConfigOptions) {
  const { apiUrl, apiVersion, retries, sendContentLength, headers } = yield* requestEnv(options);

  const envReadWriteToken = Option.map(yield* env("BLOB_READ_WRITE_TOKEN"), (token) =>
    Redacted.make(token),
  );
  const readWriteStoreId = (token: Redacted.Redacted<string>, source: string) =>
    Option.match(storeIdFromReadWriteToken(Redacted.value(token)), {
      onNone: () => Effect.fail(invalidReadWriteToken(source)),
      onSome: Effect.succeed,
    });
  if (Option.isSome(envReadWriteToken)) {
    yield* readWriteStoreId(envReadWriteToken.value, "BLOB_READ_WRITE_TOKEN");
  }

  const optionStoreId = Option.filter(
    Option.map(Option.fromUndefinedOr(options.storeId), (id) => id.trim()),
    (id) => id !== "",
  );
  const storeIdInput = Option.isSome(optionStoreId) ? optionStoreId : yield* env("BLOB_STORE_ID");

  let auth: BlobAuth;
  let readWriteToken = envReadWriteToken;
  if (options.token !== undefined) {
    const token = Redacted.isRedacted(options.token) ? options.token : Redacted.make(options.token);
    auth = BlobAuth.ReadWrite({ token, storeId: yield* readWriteStoreId(token, "token option") });
    readWriteToken = Option.some(token);
  } else if (Option.isSome(storeIdInput)) {
    const storeId = yield* Option.match(parseStoreId(storeIdInput.value), {
      onNone: () =>
        Effect.fail(
          configError(
            `Invalid store id "${storeIdInput.value}": expected store_<id> or <id> without whitespace or "_".`,
          ),
        ),
      onSome: Effect.succeed,
    });
    auth = BlobAuth.Oidc({ storeId });
  } else if (Option.isSome(envReadWriteToken)) {
    auth = BlobAuth.ReadWrite({
      token: envReadWriteToken.value,
      storeId: yield* readWriteStoreId(envReadWriteToken.value, "BLOB_READ_WRITE_TOKEN"),
    });
  } else {
    return yield* Effect.fail(noCredentials);
  }

  const webhookPublicKey = Option.isSome(Option.fromUndefinedOr(options.webhookPublicKey))
    ? Option.fromUndefinedOr(options.webhookPublicKey)
    : yield* env("BLOB_WEBHOOK_PUBLIC_KEY");
  const callbackBaseUrl = Option.isSome(Option.fromUndefinedOr(options.callbackBaseUrl))
    ? Option.fromUndefinedOr(options.callbackBaseUrl)
    : yield* env("VERCEL_BLOB_CALLBACK_URL");

  return BlobConfig.of({
    apiUrl,
    auth,
    readWriteToken,
    apiVersion,
    retries,
    sendContentLength,
    headers,
    blobBaseUrl: options.blobBaseUrl ?? defaultBlobBaseUrl,
    webhookPublicKey,
    callbackBaseUrl,
  });
});

/**
 * Builds {@link BlobConfig} from the environment, with any given values taking precedence.
 *
 * Credentials are resolved once, in the SDK's order: the `token` option; else OIDC when a store id
 * is known (`storeId` option or `BLOB_STORE_ID`), keeping `BLOB_READ_WRITE_TOKEN` as the per-request
 * fallback; else `BLOB_READ_WRITE_TOKEN`. Variables are trimmed and blank ones ignored.
 *
 * Fails with a `ConfigError` when no credentials are found, a read-write token has no store id
 * (`vercel_blob_rw_<storeId>_…`), the store id, API URL or `VERCEL_BLOB_RETRIES` is invalid.
 */
export const blobConfigLayer = (
  options: BlobConfigOptions = {},
): Layer.Layer<BlobConfig, Config.ConfigError> =>
  Layer.effect(BlobConfig, resolveBlobConfig(options));

/**
 * Reads {@link BlobConfig} from the environment: `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID`,
 * `VERCEL_BLOB_API_URL`, `VERCEL_BLOB_API_VERSION_OVERRIDE`, `VERCEL_BLOB_RETRIES` (default 10),
 * `VERCEL_BLOB_USE_X_CONTENT_LENGTH`, `VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API`,
 * `BLOB_WEBHOOK_PUBLIC_KEY` and `VERCEL_BLOB_CALLBACK_URL`. The API URL, API version and proxy
 * variables also accept a `NEXT_PUBLIC_` prefix.
 */
export const BlobConfigLive: Layer.Layer<BlobConfig, Config.ConfigError> = blobConfigLayer();
