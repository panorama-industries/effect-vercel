import { Config, ConfigProvider, Effect, Layer, Option, Redacted, Schema } from "effect";

import type { BlobAccess, StoreId } from "../contracts/blob-domain.ts";

import { BlobAuth, BlobConfig } from "../contracts/blob-config.ts";
import { parseStoreId, storeIdFromReadWriteToken } from "../internal/store-id.ts";
import { defaultApiUrl, defaultBlobBaseUrl } from "../internal/urls.ts";

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

const defaultApiVersion = "13";

const defaultRetries = 10;

const configError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

/** A variable as the SDK's `readEnv` reads it: trimmed, and absent when blank. */
const env = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) =>
      Option.filter(
        Option.map(value, (value) => value.trim()),
        (value) => value !== "",
      ),
    ),
  );

/** The first of several variables that is set, such as a name and its `NEXT_PUBLIC_` twin. */
const firstEnv = (...names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const name of names) {
      const value = yield* env(name);
      if (Option.isSome(value)) return value;
    }
    return Option.none<string>();
  });

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString);

const decodeRetries = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

const noCredentials = configError(
  "No blob credentials found. Pass a `token` option, set `BLOB_READ_WRITE_TOKEN`, or use Vercel " +
    "OIDC with a `storeId` option or `BLOB_STORE_ID`.",
);

const invalidReadWriteToken = (source: string) =>
  configError(
    `Invalid ${source}: expected a read-write token of the form vercel_blob_rw_<storeId>_<secret>.`,
  );

const resolveBlobConfig = Effect.fnUntraced(function* (options: BlobConfigOptions) {
  const apiUrlInput =
    options.apiUrl ??
    Option.getOrElse(
      yield* firstEnv("VERCEL_BLOB_API_URL", "NEXT_PUBLIC_VERCEL_BLOB_API_URL"),
      () => defaultApiUrl,
    );
  const apiUrl = yield* Option.match(decodeUrl(String(apiUrlInput)), {
    onNone: () =>
      Effect.fail(
        configError(`Invalid Blob API URL "${String(apiUrlInput)}": expected an absolute URL.`),
      ),
    onSome: Effect.succeed,
  });

  const apiVersion = Option.getOrElse(
    yield* firstEnv(
      "VERCEL_BLOB_API_VERSION_OVERRIDE",
      "NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE",
    ),
    () => defaultApiVersion,
  );

  const retries =
    options.retries ??
    (yield* Option.match(yield* env("VERCEL_BLOB_RETRIES"), {
      onNone: () => Effect.succeed(defaultRetries),
      onSome: (value) =>
        Option.match(decodeRetries(value), {
          onNone: () =>
            Effect.fail(
              configError(
                `Invalid VERCEL_BLOB_RETRIES "${value}": expected a non-negative integer.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
    }));
  if (!Number.isInteger(retries) || retries < 0) {
    return yield* Effect.fail(
      configError(`Invalid retries ${retries}: expected a non-negative integer.`),
    );
  }

  const sendContentLength = Option.contains(yield* env("VERCEL_BLOB_USE_X_CONTENT_LENGTH"), "1");

  const proxyThroughAlternativeApi = yield* firstEnv(
    "VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API",
    "NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API",
  );
  const headers = {
    ...Option.match(proxyThroughAlternativeApi, {
      onNone: () => ({}),
      onSome: (value) => ({ "x-proxy-through-alternative-api": value }),
    }),
    ...options.headers,
  };

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
