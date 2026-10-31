import { Config, ConfigProvider, Effect, Option, Schema } from "effect";

import { defaultApiUrl } from "./urls.ts";

const defaultApiVersion = "13";

const defaultRetries = 10;

/** A `ConfigError` with a message explaining what to fix. */
export const configError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

/**
 * A variable as the SDK's `readEnv` reads it: trimmed, and absent when blank. In browsers these
 * are usually `NEXT_PUBLIC_*` values inlined by the bundler, or absent.
 */
export const env = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) =>
      Option.filter(
        Option.map(value, (value) => value.trim()),
        (value) => value !== "",
      ),
    ),
  );

/** The first of several variables that is set, such as a name and its `NEXT_PUBLIC_` twin. */
export const firstEnv = (...names: ReadonlyArray<string>) =>
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

/** Values that replace what {@link requestEnv} reads from the environment. */
export interface RequestEnvOptions {
  readonly apiUrl?: URL | string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly retries?: number | undefined;
}

/** How every Blob API request is addressed and retried, shared by the server and browser clients. */
export interface RequestEnv {
  readonly apiUrl: URL;
  readonly apiVersion: string;
  readonly retries: number;
  readonly sendContentLength: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Reads the request settings the SDK's `requestApi` reads on every call: `VERCEL_BLOB_API_URL`,
 * `VERCEL_BLOB_API_VERSION_OVERRIDE`, `VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API` (each also with a
 * `NEXT_PUBLIC_` prefix), `VERCEL_BLOB_RETRIES` and `VERCEL_BLOB_USE_X_CONTENT_LENGTH`.
 *
 * Fails with a `ConfigError` when the API URL is not absolute or the retry count is not a
 * non-negative integer.
 */
export const requestEnv = Effect.fnUntraced(function* (
  options: RequestEnvOptions,
): Effect.fn.Return<RequestEnv, Config.ConfigError> {
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

  return { apiUrl, apiVersion, retries, sendContentLength, headers };
});
