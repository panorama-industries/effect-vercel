import type { VercelSystemEnv } from "@panorama-industries/effect-vercel-core";
/**
 * Side-by-side harness: runs the pinned `@vercel/blob@2.8.2` and this package against the same
 * `TestHttpServer`, records the requests each one sends, and normalizes both outcomes so they can be
 * compared with `deepStrictEqual`.
 *
 * The SDK reads `process.env` on every call, so a run stubs the variables it reads with
 * `vi.stubEnv`; our side reads the same variables through an explicit `ConfigProvider`, plus the
 * `blobConfigLayer` options that cannot come from the environment (`blobBaseUrl`).
 */
import type {
  TestHttpRequest,
  TestHttpResponse,
} from "@panorama-industries/effect-vercel-core/testing";
import type { Config } from "effect";
import type { HttpClient } from "effect/http";

import { assert } from "@effect/vitest";
import {
  OidcTokenUnavailable,
  VercelOidc,
  VercelSystemEnvLive,
  vercelOidcFromToken,
} from "@panorama-industries/effect-vercel-core";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import {
  ConfigProvider,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { createHash } from "node:crypto";
import { vi } from "vitest";

import type { BlobConfig } from "../../src/contracts/blob-config.ts";
import type {
  BlobMetadata,
  CreateFolderResult,
  ListPage,
  PutBlobResult,
} from "../../src/contracts/blob-domain.ts";

import { GetBlobResult } from "../../src/contracts/blob-domain.ts";
import { blobConfigLayer } from "../../src/implementation/blob-config-live.ts";

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

/** Store id inside {@link readWriteToken}. */
export const storeId = "12345fakeStoreId";

/** The read-write token both clients use (`BLOB_READ_WRITE_TOKEN`). */
export const readWriteToken = `vercel_blob_rw_${storeId}_30FakeRandomCharacters12345678`;

/** `BLOB_STORE_ID` for OIDC runs, with the `store_` prefix both clients strip. */
export const oidcStoreIdEnv = "store_oidcStore1";

/** {@link oidcStoreIdEnv} without its prefix, as sent in `x-vercel-blob-store-id`. */
export const oidcStoreId = "oidcStore1";

const base64Url = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/**
 * An unsigned JWT that expires in 2100, so `@vercel/oidc` uses it as is instead of trying to
 * refresh it from the Vercel CLI.
 */
export const oidcToken = `${base64Url('{"alg":"none","typ":"JWT"}')}.${base64Url(
  JSON.stringify({ sub: "owner:team:project:p:environment:preview", exp: 4_102_444_800 }),
)}.`;

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/**
 * How both clients authenticate:
 * - `readWrite`: `BLOB_READ_WRITE_TOKEN` only.
 * - `oidc`: `VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID` (the read-write token is also set).
 * - `oidcFallback`: `BLOB_STORE_ID` but no OIDC token, so both fall back to the read-write token.
 */
export type AuthMode = "readWrite" | "oidc" | "oidcFallback";

/** One configuration shared by the SDK (as environment variables) and our layers. */
export interface Setup {
  readonly auth: AuthMode;

  /** `VERCEL_BLOB_RETRIES`; 0 unless a case compares retries deliberately. */
  readonly retries?: number | undefined;

  /** Set to false to leave `BLOB_READ_WRITE_TOKEN` unset (with an OIDC `auth`). */
  readonly readWriteToken?: boolean | undefined;

  /** Extra environment variables for both sides, such as `VERCEL_BLOB_CALLBACK_URL`. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** Read-write token, no retries. */
export const readWriteSetup: Setup = { auth: "readWrite" };

/** OIDC token plus store id, no retries. */
export const oidcSetup: Setup = { auth: "oidc" };

/** Store id without an OIDC token, so both clients fall back to the read-write token. */
export const oidcFallbackSetup: Setup = { auth: "oidcFallback" };

/**
 * Variables either client reads. Each run unsets the ones its setup does not define, so the
 * developer's shell cannot leak into a comparison.
 */
const managedVariables = [
  "VERCEL_BLOB_API_URL",
  "NEXT_PUBLIC_VERCEL_BLOB_API_URL",
  "VERCEL_BLOB_API_VERSION_OVERRIDE",
  "NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE",
  "VERCEL_BLOB_RETRIES",
  "VERCEL_BLOB_USE_X_CONTENT_LENGTH",
  "VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API",
  "NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_PROJECT_ID",
  "VERCEL_ORG_ID",
  "BLOB_WEBHOOK_PUBLIC_KEY",
  "VERCEL_BLOB_CALLBACK_URL",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_REGION",
  "VERCEL_DEPLOYMENT_ID",
] as const;

/** The Blob API base URL on the test server: `<server>/api/blob`. */
export const apiUrl = (server: string): string => `${server}/api/blob`;

/** The environment both clients see for `setup`. */
export const environment = (server: string, setup: Setup): Record<string, string> => ({
  VERCEL_BLOB_API_URL: apiUrl(server),
  VERCEL_BLOB_RETRIES: String(setup.retries ?? 0),
  ...(setup.readWriteToken === false ? {} : { BLOB_READ_WRITE_TOKEN: readWriteToken }),
  ...(setup.auth === "oidc" ? { VERCEL_OIDC_TOKEN: oidcToken, BLOB_STORE_ID: oidcStoreIdEnv } : {}),
  ...(setup.auth === "oidcFallback" ? { BLOB_STORE_ID: oidcStoreIdEnv } : {}),
  ...setup.env,
});

const stubEnvironment = (env: Readonly<Record<string, string>>) => {
  for (const name of managedVariables) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
};

/**
 * Where our `get` reads a store's blobs: `<server>/<access>/` on the test server, so a pathname
 * `get` lands on the same origin the SDK is pointed at with a URL.
 */
export const testBlobBaseUrl = (server: string) => (_storeId: string, access: string) =>
  new URL(`${server}/${access}/`);

const unavailableOidc = Layer.succeed(
  VercelOidc,
  VercelOidc.of({
    token: Effect.fail(
      new OidcTokenUnavailable({ message: "No OIDC token in the differential test." }),
    ),
  }),
);

/** Services our implementation layers may require; every run provides all of them. */
export type BaseServices = BlobConfig | VercelOidc | VercelSystemEnv | HttpClient.HttpClient;

/** Our side's configuration for `setup`: the same environment the SDK sees, plus explicit options. */
export const baseLayer = (
  server: string,
  setup: Setup,
  options: { readonly defaultBlobBaseUrl?: boolean | undefined } = {},
): Layer.Layer<BaseServices, Config.ConfigError> => {
  const config = blobConfigLayer({
    apiUrl: apiUrl(server),
    retries: setup.retries ?? 0,
    ...(setup.auth === "readWrite" ? { token: readWriteToken } : { storeId: oidcStoreIdEnv }),
    ...(options.defaultBlobBaseUrl === true ? {} : { blobBaseUrl: testBlobBaseUrl(server) }),
  });
  const oidc =
    setup.auth === "oidc" ? vercelOidcFromToken(Redacted.make(oidcToken)) : unavailableOidc;
  const http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer;
  return Layer.mergeAll(config, oidc, VercelSystemEnvLive, http).pipe(
    Layer.provide(configProviderLayer(server, setup)),
  );
};

/** The environment of `setup` as our `ConfigProvider`, for layers that read `Config`. */
export const configProviderLayer = (server: string, setup: Setup): Layer.Layer<never> =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: environment(server, setup) }));

/**
 * Run `body` against a fresh `TestHttpServer`, with the SDK's environment stubbed for `setup` and
 * `services` (our implementation layers) built on top of {@link baseLayer}.
 */
export const differential =
  <ROut, E>(
    services: Layer.Layer<ROut, E, BaseServices>,
    setup: Setup = readWriteSetup,
    options: { readonly defaultBlobBaseUrl?: boolean | undefined } = {},
  ) =>
  <A, E2>(
    body: Effect.Effect<A, E2, ROut | BaseServices | TestHttpServer>,
  ): Effect.Effect<A, E | E2 | Config.ConfigError> =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      yield* Effect.sync(() => stubEnvironment(environment(server.url, setup)));
      return yield* body.pipe(
        Effect.provide(
          services.pipe(
            Layer.provideMerge(baseLayer(server.url, setup, options)),
            Layer.provide(configProviderLayer(server.url, setup)),
          ),
        ),
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
      Effect.provide(TestHttpServerLive()),
    );

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * Headers neither client controls identically, left out of request comparisons:
 *
 * - `user-agent`: the SDK calls its own `undici@6` `fetch` (`undici`), we call the runtime's
 *   global `fetch` (`node`).
 * - `connection`, `keep-alive`, `host`: transport details of each client's connection pool (both
 *   target the same server).
 * - `content-length`, `transfer-encoding`: framing; whether a body is sent with a length or chunked
 *   depends on how each `fetch` sees the body. The body itself is compared byte for byte.
 * - `traceparent`, `tracestate`, `b3`, `baggage`: trace propagation; the SDK sends none and ours
 *   disables it, so this only guards against an ambient tracer.
 *
 * The fetch-spec defaults (`accept`, `accept-language`, `sec-fetch-mode`, `accept-encoding`) are
 * identical in both `fetch` implementations and are compared. `x-api-blob-request-id` is compared by
 * shape (`<storeId>:<epoch ms>:<hex>`), since its time and random parts differ per call.
 */
export const ignoredHeaders: ReadonlySet<string> = new Set([
  "user-agent",
  "connection",
  "keep-alive",
  "host",
  "content-length",
  "transfer-encoding",
  "traceparent",
  "tracestate",
  "b3",
  "baggage",
]);

/** A request as compared: volatile headers dropped, request id reduced to its shape. */
export interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** UTF-8 text for small bodies, `<n bytes sha256:…>` for large or binary ones. */
  readonly body: string;
}

const requestIdShape = /^([^:]*):(\d{13}):([0-9a-f]+)$/;

const describeBody = (body: Uint8Array): string => {
  if (body.length <= 4096) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    if (!text.includes("�")) return text;
  }
  return `<${body.length} bytes sha256:${createHash("sha256").update(body).digest("hex")}>`;
};

/** Normalize one recorded request for comparison. */
export const normalizeRequest = (request: TestHttpRequest): WireRequest => {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(request.headers).toSorted()) {
    if (ignoredHeaders.has(name)) continue;
    const value = request.headers[name] ?? "";
    headers[name] =
      name === "x-api-blob-request-id"
        ? value.replace(requestIdShape, "$1:<epoch-ms>:<hex>")
        : value;
  }
  return { method: request.method, url: request.url, headers, body: describeBody(request.body) };
};

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/** A normalized success value, or the SDK-equivalent label of the failure. */
export type Outcome<A> = { readonly ok: A } | { readonly error: string };

/**
 * Label of an SDK failure: the error class, plus the detail that distinguishes it (the message for
 * classes whose message comes from the response, the `retryAfter` seconds for rate limits).
 */
export const sdkErrorLabel = (error: unknown): string => {
  if (!(error instanceof Error)) return `NonError(${String(error)})`;
  const name = error.constructor.name;
  const message = error.message.replace(/^Vercel Blob: /, "");
  switch (name) {
    case "BlobError":
    case "BlobContentTypeNotAllowedError":
    case "BlobFileTooLargeError":
    case "BlobPathnameMismatchError":
    case "BlobOidcEnvironmentNotAllowedError":
      return `${name}(${message})`;
    case "BlobServiceRateLimited":
      return `BlobServiceRateLimited(${(error as Error & { retryAfter: number }).retryAfter})`;
    default:
      return name;
  }
};

/** Domain codes; a `VercelApiError` carrying one means the operation's contract filtered it out. */
const domainCodes: ReadonlySet<string> = new Set([
  "not_found",
  "store_not_found",
  "store_suspended",
  "precondition_failed",
  "client_token_not_allowed",
  "oidc_environment_not_allowed",
  "content_type_not_allowed",
  "file_too_large",
  "client_token_pathname_mismatch",
  "client_token_expired",
]);

interface TaggedError {
  readonly _tag: string;
  readonly reason?: unknown;
  readonly message?: string;
  readonly errorCode?: Option.Option<string>;
}

const tagOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "_tag" in value ? String(value._tag) : "?";

const messageOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "message" in value ? String(value.message) : "";

/** `Tag` or `Tag/ReasonTag`: what our failure is, for the mapping table. */
export const ourErrorTag = (error: unknown): string => {
  const tagged = error as TaggedError;
  const reason = tagged.reason === undefined ? "" : `/${tagOf(tagged.reason)}`;
  return `${tagOf(error)}${reason}`;
};

const retryAfterSeconds = (reason: unknown): number => {
  const retryAfter = (reason as { readonly retryAfter?: Option.Option<Duration.Duration> })
    .retryAfter;
  return retryAfter === undefined
    ? 0
    : Option.match(retryAfter, {
        onNone: () => 0,
        onSome: (duration) => Duration.toSeconds(duration),
      });
};

/**
 * The SDK label that our failure corresponds to, per {@link errorMapping}. A `VercelApiError` that
 * carries a domain code is labelled `Undeclared(<code>)`: the operation's contract does not declare
 * that domain error, so it is reported as a generic API error.
 */
export const ourErrorLabel = (error: unknown): string => {
  const label = errorLabels[tagOf(error)];
  return label === undefined
    ? `${ourErrorTag(error)}(${messageOf(error)})`
    : label(error as TaggedError);
};

const uploadRejectedLabels: Readonly<Record<string, (reason: unknown) => string>> = {
  ContentTypeNotAllowed: (reason) => `BlobContentTypeNotAllowedError(${messageOf(reason)})`,
  FileTooLarge: (reason) => `BlobFileTooLargeError(${messageOf(reason)})`,
  PathnameMismatch: (reason) => `BlobPathnameMismatchError(${messageOf(reason)})`,
  ClientTokenExpired: () => "BlobClientTokenExpiredError",
};

const eventRejectedLabels: Readonly<Record<string, string>> = {
  SignatureMissing: "BlobError(Missing callback signature)",
  SignatureInvalid: "BlobError(Invalid callback signature)",
  WebhookPublicKeyMissing: "BlobError(Missing webhook public key)",
};

const apiErrorLabel = (error: TaggedError): string => {
  const code = Option.getOrElse(error.errorCode ?? Option.none(), () => "");
  const reasonTag = tagOf(error.reason);
  if (domainCodes.has(code)) return `Undeclared(${code})`;
  if (reasonTag === "ApiNetworkFailure") return "Network";
  if (code === "forbidden" && reasonTag === "ApiForbidden") return "BlobAccessError";
  if (code === "rate_limited" && reasonTag === "ApiRateLimited") {
    return `BlobServiceRateLimited(${retryAfterSeconds(error.reason)})`;
  }
  if (code === "bad_request" && reasonTag === "ApiBadRequest") {
    return `BlobError(${messageOf(error.reason)})`;
  }
  if (code === "service_unavailable") return "BlobServiceNotAvailable";
  // The SDK throws `BlobUnknownError` for every other code whatever the status; the reason (from
  // the status) is checked separately against `errorMapping`.
  return "BlobUnknownError";
};

/** Our error tag to the SDK label it corresponds to; see {@link errorMapping}. */
const errorLabels: Readonly<Record<string, (error: TaggedError) => string>> = {
  BlobNotFound: () => "BlobNotFoundError",
  BlobStoreUnavailable: (error) =>
    tagOf(error.reason) === "BlobStoreSuspended"
      ? "BlobStoreSuspendedError"
      : "BlobStoreNotFoundError",
  BlobPreconditionFailed: () => "BlobPreconditionFailedError",
  BlobUploadRejected: (error) =>
    uploadRejectedLabels[tagOf(error.reason)]?.(error.reason) ?? "BlobUploadRejected(?)",
  BlobClientTokenNotAllowed: (error) => `BlobError(${messageOf(error)})`,
  BlobOidcEnvironmentNotAllowed: (error) =>
    `BlobOidcEnvironmentNotAllowedError(${messageOf(error)})`,
  BlobUploadAuthorizationFailed: (error) => `BlobError(${messageOf(error)})`,
  BlobPresignFailed: (error) => `BlobError(${messageOf(error)})`,
  OidcTokenUnavailable: () => "OidcTokenUnavailable",
  BlobReadWriteTokenRequired: () =>
    "BlobError(No read-write token found. Either configure the `BLOB_READ_WRITE_TOKEN` environment variable, or pass a `token` option to your calls.)",
  BlobUploadEventRejected: (error) =>
    eventRejectedLabels[tagOf(error.reason)] ?? `EventMalformed(${messageOf(error.reason)})`,
  VercelApiError: apiErrorLabel,
};

/** One row of the SDK-to-ours error mapping. */
export interface ErrorMappingRow {
  /** Case name. */
  readonly name: string;
  readonly response: TestHttpResponse;
  /** What the SDK throws ({@link sdkErrorLabel}). */
  readonly sdk: string;
  /** What we fail with ({@link ourErrorTag}) when the operation declares the domain error. */
  readonly ours: string;
  /** Domain error the row maps to; operations that do not declare it report a `VercelApiError`. */
  readonly domain?: string | undefined;
  /** Our label ({@link ourErrorLabel}) when the operation does not declare {@link domain}. */
  readonly undeclared?: string | undefined;
}

const jsonError = (
  status: number,
  code: string | undefined,
  message?: string,
  headers: Record<string, string> = {},
): TestHttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({
    error: {
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
    },
  }),
});

const unknownMessage = "Unknown error, please visit https://vercel.com/help.";

/**
 * SDK error class to our error, for every body error code of the design doc's table and the
 * message rewrites `getBlobError` applies. `ours` is `Tag/ReasonTag`.
 */
export const errorMapping: ReadonlyArray<ErrorMappingRow> = [
  {
    name: "not_found",
    response: jsonError(404, "not_found", "The requested blob does not exist"),
    sdk: "BlobNotFoundError",
    ours: "BlobNotFound",
    domain: "BlobNotFound",
    undeclared: "Undeclared(not_found)",
  },
  {
    name: "store_not_found",
    response: jsonError(404, "store_not_found", "This store does not exist."),
    sdk: "BlobStoreNotFoundError",
    ours: "BlobStoreUnavailable/BlobStoreNotFound",
    domain: "BlobStoreUnavailable",
  },
  {
    name: "store_suspended",
    response: jsonError(403, "store_suspended", "This store has been suspended."),
    sdk: "BlobStoreSuspendedError",
    ours: "BlobStoreUnavailable/BlobStoreSuspended",
    domain: "BlobStoreUnavailable",
  },
  {
    name: "forbidden",
    response: jsonError(403, "forbidden", "Access denied"),
    sdk: "BlobAccessError",
    ours: "VercelApiError/ApiForbidden",
  },
  {
    name: "bad_request",
    response: jsonError(400, "bad_request", "Invalid pathname"),
    sdk: "BlobError(Invalid pathname)",
    ours: "VercelApiError/ApiBadRequest",
  },
  {
    name: "bad_request without message",
    response: jsonError(400, "bad_request"),
    sdk: "BlobError(Bad request)",
    ours: "VercelApiError/ApiBadRequest",
  },
  {
    name: "rate_limited with Retry-After",
    response: jsonError(429, "rate_limited", "Too many requests", { "retry-after": "17" }),
    sdk: "BlobServiceRateLimited(17)",
    ours: "VercelApiError/ApiRateLimited",
  },
  {
    name: "rate_limited without Retry-After",
    response: jsonError(429, "rate_limited", "Too many requests"),
    sdk: "BlobServiceRateLimited(0)",
    ours: "VercelApiError/ApiRateLimited",
  },
  {
    name: "service_unavailable",
    response: jsonError(503, "service_unavailable", "Down"),
    sdk: "BlobServiceNotAvailable",
    ours: "VercelApiError/ApiServerError",
  },
  {
    name: "unknown_error",
    response: jsonError(500, "unknown_error", "Boom"),
    sdk: "BlobUnknownError",
    ours: "VercelApiError/ApiServerError",
  },
  {
    name: "not_allowed",
    response: jsonError(405, "not_allowed", unknownMessage),
    sdk: "BlobUnknownError",
    ours: "VercelApiError/ApiUnexpectedResponse",
  },
  {
    name: "unlisted code",
    response: jsonError(418, "teapot", unknownMessage),
    sdk: "BlobUnknownError",
    ours: "VercelApiError/ApiUnexpectedResponse",
  },
  {
    name: "precondition_failed",
    response: jsonError(412, "precondition_failed", "ETag mismatch"),
    sdk: "BlobPreconditionFailedError",
    ours: "BlobPreconditionFailed",
    domain: "BlobPreconditionFailed",
    undeclared: "Undeclared(precondition_failed)",
  },
  {
    name: "client_token_not_allowed",
    response: jsonError(403, "client_token_not_allowed", "Not with a client token"),
    sdk: "BlobError(Not with a client token)",
    ours: "BlobClientTokenNotAllowed",
    domain: "BlobClientTokenNotAllowed",
    undeclared: "Undeclared(client_token_not_allowed)",
  },
  {
    name: "client_token_not_allowed without message",
    response: jsonError(403, "client_token_not_allowed"),
    sdk: "BlobError(This operation is not available when using a client token. Use a read–write or OIDC token on the server.)",
    ours: "BlobClientTokenNotAllowed",
    domain: "BlobClientTokenNotAllowed",
    undeclared: "Undeclared(client_token_not_allowed)",
  },
  {
    name: "oidc_environment_not_allowed",
    response: jsonError(403, "oidc_environment_not_allowed"),
    sdk: "BlobOidcEnvironmentNotAllowedError(OIDC is enabled for this project, but not for this token's environment.)",
    ours: "BlobOidcEnvironmentNotAllowed",
    domain: "BlobOidcEnvironmentNotAllowed",
    undeclared: "Undeclared(oidc_environment_not_allowed)",
  },
  {
    name: "rewrite: contentType not allowed",
    response: jsonError(400, "bad_request", 'contentType "text/plain" is not allowed'),
    sdk: 'BlobContentTypeNotAllowedError(Content type mismatch, contentType "text/plain" is not allowed.)',
    ours: "BlobUploadRejected/ContentTypeNotAllowed",
    domain: "BlobUploadRejected",
    undeclared: 'BlobError(contentType "text/plain" is not allowed)',
  },
  {
    name: "rewrite: pathname mismatch",
    response: jsonError(400, "bad_request", '"pathname" foo.txt does not match the token payload'),
    sdk: 'BlobPathnameMismatchError(Pathname mismatch, "pathname" foo.txt does not match the token payload. Check the pathname used in upload() or put() matches the one from the client token.)',
    ours: "BlobUploadRejected/PathnameMismatch",
    domain: "BlobUploadRejected",
    undeclared: 'BlobError("pathname" foo.txt does not match the token payload)',
  },
  {
    name: "rewrite: token expired",
    response: jsonError(400, "bad_request", "Token expired"),
    sdk: "BlobClientTokenExpiredError",
    ours: "BlobUploadRejected/ClientTokenExpired",
    domain: "BlobUploadRejected",
    undeclared: "BlobError(Token expired)",
  },
  {
    name: "rewrite: file too large",
    response: jsonError(400, "bad_request", "the file length cannot be greater than 100 bytes"),
    sdk: "BlobFileTooLargeError(File is too large, the file length cannot be greater than 100 bytes.)",
    ours: "BlobUploadRejected/FileTooLarge",
    domain: "BlobUploadRejected",
    undeclared: "BlobError(the file length cannot be greater than 100 bytes)",
  },
  {
    name: "rewrite: OIDC environment",
    response: jsonError(
      403,
      "forbidden",
      "OIDC is enabled for this project, but not for the preview environment.",
    ),
    sdk: "BlobOidcEnvironmentNotAllowedError(OIDC is enabled for this project, but not for the preview environment.)",
    ours: "BlobOidcEnvironmentNotAllowed",
    domain: "BlobOidcEnvironmentNotAllowed",
    undeclared: "BlobAccessError",
  },
  {
    name: "non-JSON 500",
    response: { status: 500, headers: { "content-type": "text/plain" }, body: "upstream exploded" },
    sdk: "BlobUnknownError",
    ours: "VercelApiError/ApiServerError",
  },
  {
    name: "JSON 502 without error",
    response: { status: 502, headers: { "content-type": "application/json" }, body: "{}" },
    sdk: "BlobUnknownError",
    ours: "VercelApiError/ApiServerError",
  },
];

/** Run an SDK call and normalize its value or label its failure. */
export const sdkOutcome = <A, B>(
  call: () => Promise<A>,
  normalize: (value: A) => B | Promise<B>,
): Effect.Effect<Outcome<B>> =>
  Effect.promise(() =>
    call().then(
      async (value): Promise<Outcome<B>> => ({ ok: await normalize(value) }),
      (error: unknown): Outcome<B> => ({ error: sdkErrorLabel(error) }),
    ),
  );

/** Run our effect and normalize its value or label its failure like the SDK's. */
export const ourOutcome = <A, B, E, R>(
  effect: Effect.Effect<A, E, R>,
  normalize: (value: A) => B | Effect.Effect<B>,
): Effect.Effect<Outcome<B> & { readonly tag?: string }, never, R> =>
  effect.pipe(
    Effect.flatMap((value) => {
      const normalized = normalize(value);
      return Effect.isEffect(normalized)
        ? Effect.map(normalized, (ok): Outcome<B> => ({ ok }))
        : Effect.succeed<Outcome<B>>({ ok: normalized });
    }),
    Effect.catch((error: E) =>
      Effect.succeed({ error: ourErrorLabel(error), tag: ourErrorTag(error) }),
    ),
  );

/** Both outcomes and the requests each side sent, in arrival order. */
export interface Comparison<B> {
  readonly sdk: Outcome<B>;
  /** Our outcome; `tag` is {@link ourErrorTag} of a failure. */
  readonly ours: Outcome<B> & { readonly tag?: string };
  readonly sdkRequests: ReadonlyArray<WireRequest>;
  readonly ourRequests: ReadonlyArray<WireRequest>;
}

/** What the test server answers: one fixed reply, or one computed per request. */
export type Responder = TestHttpResponse | ((request: TestHttpRequest) => TestHttpResponse);

/**
 * Answer requests with `responder`, run the SDK call and then ours, and return both outcomes with
 * every request each one sent.
 */
export const compare = Effect.fnUntraced(function* <B, R>(
  responder: Responder,
  sdk: (server: string) => Effect.Effect<Outcome<B>>,
  ours: Effect.Effect<Outcome<B> & { readonly tag?: string }, never, R>,
): Effect.fn.Return<Comparison<B>, never, R | TestHttpServer> {
  const server = yield* TestHttpServer;
  yield* server.setHandler(typeof responder === "function" ? responder : () => responder);
  const before = (yield* server.requests).length;
  const sdkResult = yield* sdk(server.url);
  const middle = (yield* server.requests).length;
  const ourResult = yield* ours;
  const requests = yield* server.requests;
  return {
    sdk: sdkResult,
    ours: ourResult,
    sdkRequests: requests.slice(before, middle).map(normalizeRequest),
    ourRequests: requests.slice(middle).map(normalizeRequest),
  };
});

/** Drop `tag` so an outcome can be compared with the SDK's. */
export const withoutTag = <B>(outcome: Outcome<B> & { readonly tag?: string }): Outcome<B> =>
  "ok" in outcome ? { ok: outcome.ok } : { error: outcome.error };

// ---------------------------------------------------------------------------------------------
// Fixtures and result normalizers
// ---------------------------------------------------------------------------------------------

/** JSON reply with status 200. */
export const json = (body: unknown, headers: Record<string, string> = {}): TestHttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

/** A blob as the API returns it from writes. */
export const putResponse = (pathname = "foo.txt", contentType = "text/plain") => ({
  url: `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/${pathname}`,
  downloadUrl: `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/${pathname}?download=1`,
  pathname,
  contentType,
  contentDisposition: `attachment; filename="${pathname.split("/").at(-1) ?? pathname}"`,
  etag: '"etag-1"',
});

/** A blob as `put`, `copy`, `rename` and multipart completion return it. */
export interface PutResultWire {
  readonly url: string;
  readonly downloadUrl: string;
  readonly pathname: string;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly etag: string;
}

/** Normalize the SDK's `PutBlobResult` (or `copy`/`rename` result). */
export const sdkPutResult = (result: PutResultWire): PutResultWire => ({
  url: result.url,
  downloadUrl: result.downloadUrl,
  pathname: result.pathname,
  contentType: result.contentType,
  contentDisposition: result.contentDisposition,
  etag: result.etag,
});

/** Normalize our `PutBlobResult`. */
export const ourPutResult = (result: PutBlobResult): PutResultWire => ({
  url: result.url.href,
  downloadUrl: result.downloadUrl.href,
  pathname: result.pathname,
  contentType: result.contentType,
  contentDisposition: result.contentDisposition,
  etag: result.etag,
});

/** `head` as compared: `uploadedAt` as an ISO string. */
export interface HeadResultWire extends Omit<PutResultWire, "contentType"> {
  readonly contentType: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly cacheControl: string;
}

/** Normalize the SDK's `head` result. */
export const sdkHeadResult = (result: {
  readonly url: string;
  readonly downloadUrl: string;
  readonly pathname: string;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly etag: string;
  readonly size: number;
  readonly uploadedAt: Date;
  readonly cacheControl: string;
}): HeadResultWire => ({
  url: result.url,
  downloadUrl: result.downloadUrl,
  pathname: result.pathname,
  contentType: result.contentType,
  contentDisposition: result.contentDisposition,
  etag: result.etag,
  size: result.size,
  uploadedAt: result.uploadedAt.toISOString(),
  cacheControl: result.cacheControl,
});

/** Normalize our `BlobMetadata`. */
export const ourHeadResult = (result: BlobMetadata): HeadResultWire => ({
  url: result.url.href,
  downloadUrl: result.downloadUrl.href,
  pathname: result.pathname,
  contentType: result.contentType,
  contentDisposition: result.contentDisposition,
  etag: result.etag,
  size: result.size,
  uploadedAt: DateTime.formatIso(result.uploadedAt),
  cacheControl: result.cacheControl,
});

/** One listing page as compared; `folders` is empty for an expanded SDK listing. */
export interface ListResultWire {
  readonly blobs: ReadonlyArray<{
    readonly url: string;
    readonly downloadUrl: string;
    readonly pathname: string;
    readonly size: number;
    readonly uploadedAt: string;
    readonly etag: string;
  }>;
  readonly folders: ReadonlyArray<string>;
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

/** Normalize the SDK's `list` result. */
export const sdkListResult = (result: {
  readonly blobs: ReadonlyArray<{
    readonly url: string;
    readonly downloadUrl: string;
    readonly pathname: string;
    readonly size: number;
    readonly uploadedAt: Date;
    readonly etag: string;
  }>;
  readonly folders?: ReadonlyArray<string>;
  readonly cursor?: string | undefined;
  readonly hasMore: boolean;
}): ListResultWire => ({
  blobs: result.blobs.map((blob) => ({
    url: blob.url,
    downloadUrl: blob.downloadUrl,
    pathname: blob.pathname,
    size: blob.size,
    uploadedAt: blob.uploadedAt.toISOString(),
    etag: blob.etag,
  })),
  folders: result.folders ?? [],
  cursor: result.cursor ?? null,
  hasMore: result.hasMore,
});

/** Normalize our `ListPage`. */
export const ourListResult = (page: ListPage): ListResultWire => ({
  blobs: page.blobs.map((blob) => ({
    url: blob.url.href,
    downloadUrl: blob.downloadUrl.href,
    pathname: blob.pathname,
    size: blob.size,
    uploadedAt: DateTime.formatIso(blob.uploadedAt),
    etag: blob.etag,
  })),
  folders: page.folders,
  cursor: Option.getOrNull(page.cursor),
  hasMore: page.hasMore,
});

/** Normalize the SDK's `createFolder` result. */
export const sdkFolderResult = (result: { readonly url: string; readonly pathname: string }) => ({
  url: result.url,
  pathname: result.pathname,
});

/** Normalize our `CreateFolderResult`. */
export const ourFolderResult = (result: CreateFolderResult) => ({
  url: result.url.href,
  pathname: result.pathname,
});

/** `get` as compared: status, metadata, selected headers and the content as text. */
export interface GetResultWire {
  readonly status: number;
  readonly blob: {
    readonly url: string;
    readonly downloadUrl: string;
    readonly pathname: string;
    readonly contentDisposition: string;
    readonly cacheControl: string;
    readonly uploadedAt: string;
    readonly etag: string;
  };
  readonly contentType: string | null;
  readonly size: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

const volatileResponseHeaders = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);

const stableHeaders = (entries: Iterable<readonly [string, string]>) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of [...entries].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!volatileResponseHeaders.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  }
  return headers;
};

interface SdkGetBlob {
  readonly url: string;
  readonly downloadUrl: string;
  readonly pathname: string;
  readonly contentDisposition: string;
  readonly cacheControl: string;
  readonly uploadedAt: Date;
  readonly etag: string;
  readonly contentType: string | null;
  readonly size: number | null;
}

/** Normalize the SDK's `get` result; `null` (404) stays `null`. */
export const sdkGetResult = async (
  result: {
    readonly statusCode: number;
    readonly stream: ReadableStream<Uint8Array> | null;
    readonly headers: { entries(): Iterable<[string, string]> };
    readonly blob: SdkGetBlob;
  } | null,
): Promise<GetResultWire | null> =>
  result === null
    ? null
    : {
        status: result.statusCode,
        blob: {
          url: result.blob.url,
          downloadUrl: result.blob.downloadUrl,
          pathname: result.blob.pathname,
          contentDisposition: result.blob.contentDisposition,
          cacheControl: result.blob.cacheControl,
          uploadedAt: result.blob.uploadedAt.toISOString(),
          etag: result.blob.etag,
        },
        contentType: result.blob.contentType,
        size: result.blob.size,
        headers: stableHeaders(result.headers.entries()),
        body: result.stream === null ? null : await new Response(result.stream).text(),
      };

/** Normalize our `GetBlobResult`, reading the body of `Found`. */
export const ourGetResult = (result: GetBlobResult): Effect.Effect<GetResultWire> => {
  const blob = {
    url: result.blob.url.href,
    downloadUrl: result.blob.downloadUrl.href,
    pathname: result.blob.pathname,
    contentDisposition: result.blob.contentDisposition,
    cacheControl: result.blob.cacheControl,
    uploadedAt: DateTime.formatIso(result.blob.uploadedAt),
    etag: result.blob.etag,
  };
  const headers = stableHeaders(Object.entries(result.headers));
  if (GetBlobResult.$is("NotModified")(result)) {
    return Effect.succeed({
      status: 304,
      blob,
      contentType: null,
      size: null,
      headers,
      body: null,
    });
  }
  return Stream.mkString(Stream.decodeText(result.body)).pipe(
    Effect.orDie,
    Effect.map((text) => ({
      status: 200,
      blob,
      contentType: result.contentType,
      size: result.size,
      headers,
      body: text,
    })),
  );
};

/** Sort multipart part uploads by part number, keeping other requests in place. */
export const sortParts = (requests: ReadonlyArray<WireRequest>): ReadonlyArray<WireRequest> => {
  const parts = requests
    .filter((request) => request.headers["x-mpu-action"] === "upload")
    .toSorted(
      (a, b) =>
        Number(a.headers["x-mpu-part-number"] ?? 0) - Number(b.headers["x-mpu-part-number"] ?? 0),
    );
  let index = 0;
  return requests.map((request) => {
    if (request.headers["x-mpu-action"] !== "upload") return request;
    const sorted = parts[index++];
    return sorted ?? request;
  });
};

/** A completion body (`[{etag, partNumber}]`) with its parts sorted by part number. */
export const sortCompletionBody = (request: WireRequest): WireRequest => {
  if (request.headers["x-mpu-action"] !== "complete") return request;
  const parts = JSON.parse(request.body) as Array<{ partNumber: number }>;
  return {
    ...request,
    body: JSON.stringify(parts.toSorted((a, b) => a.partNumber - b.partNumber)),
  };
};

/** One upload-progress event as either client reports it. */
interface ProgressEvent {
  readonly loaded: number;
  readonly total: number;
  readonly percentage: number;
}

/**
 * Asserts that two progress sequences agree where timing cannot change them: the same first and
 * last event, and loaded bytes that never decrease. How many throttled events fall in between
 * depends on how long the upload takes, which a loaded machine changes.
 */
export const assertSameProgress = (
  ours: ReadonlyArray<ProgressEvent>,
  sdk: ReadonlyArray<ProgressEvent>,
): void => {
  assert.deepStrictEqual(ours.at(0), sdk.at(0), "first event");
  assert.deepStrictEqual(ours.at(-1), sdk.at(-1), "last event");
  for (const events of [ours, sdk]) {
    events.forEach((event, index) => {
      assert.isAtMost(event.loaded, event.total, "loaded within total");
      if (index > 0) assert.isAtLeast(event.loaded, events[index - 1]!.loaded, "loaded grows");
    });
  }
};
