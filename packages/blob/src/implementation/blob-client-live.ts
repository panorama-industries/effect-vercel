import type { Array } from "effect";

import { Config, Effect, Layer, Option, Predicate, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type {
  BlobClientError,
  ClientUploadOptions,
  UploadRouteOptions,
} from "../contracts/blob-client.ts";
import type {
  BlobAccess,
  BlobBody,
  BlobPathname,
  ClientToken,
  PartNumber,
  PutBlobResult,
  UploadedPart,
} from "../contracts/blob-domain.ts";
import type { BlobDomainErrorTag } from "../internal/blob-errors.ts";
import type { BlobRequestSettings } from "../internal/blob-request.ts";

import { BlobClient } from "../contracts/blob-client.ts";
import {
  ClientToken as ClientTokenSchema,
  MultipartUpload,
  PresignedUrlPayload,
} from "../contracts/blob-domain.ts";
import { BlobUploadAuthorizationFailed } from "../contracts/blob-errors.ts";
import { BlobRequestAuth, blobRequester } from "../internal/blob-request.ts";
import { requestEnv } from "../internal/env.ts";
import * as Multipart from "../internal/multipart.ts";
import { storeIdFromClientToken, storeIdFromDelegationToken } from "../internal/store-id.ts";
import { PutBlobResponse } from "../internal/wire.ts";
import { allowedWriteOptions, writeHeaders } from "../internal/write-headers.ts";

/** Values that replace what {@link BlobClientLive} reads from the environment. */
export interface BlobClientOptions {
  /**
   * Blob API base URL; replaces `VERCEL_BLOB_API_URL` and `NEXT_PUBLIC_VERCEL_BLOB_API_URL`, for an
   * emulator or a test server.
   */
  readonly apiUrl?: URL | string | undefined;

  /**
   * Extra headers for every Blob API request, merged over the environment's. Headers for the
   * upload route are given per upload instead.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;

  /** Retries after the first attempt; replaces `VERCEL_BLOB_RETRIES` (default 10). */
  readonly retries?: number | undefined;
}

/** The SDK wraps a single upload's `onUploadProgress` in `throttle(…, 100)`. */
const singleUploadProgressInterval = "100 millis";

/** The domain errors {@link BlobClientError} declares; other error codes become `VercelApiError`. */
const clientDomainErrors = [
  "BlobStoreUnavailable",
  "BlobUploadRejected",
  "BlobPreconditionFailed",
  "BlobClientTokenNotAllowed",
] as const satisfies ReadonlyArray<BlobDomainErrorTag>;

/**
 * The request settings of the browser client, read like the SDK's `requestApi` reads them. There
 * is no server `BlobConfig` here: credentials come with each upload.
 */
const resolveClientSettings = Effect.fnUntraced(function* (
  options: BlobClientOptions,
  httpClient: HttpClient.HttpClient,
): Effect.fn.Return<BlobRequestSettings, Config.ConfigError> {
  const { apiUrl, apiVersion, retries, sendContentLength, headers } = yield* requestEnv(options);
  return { httpClient, apiUrl, apiVersion, retries, sendContentLength, headers };
});

/** Event types the browser posts to the upload route, as the SDK's `EventTypes`. */
type UploadRouteEventType = "blob.generate-client-token" | "blob.generate-presigned-url";

/** The SDK's messages for a route that cannot be reached or answers with a non-2xx status. */
const routeFailedMessages = {
  "blob.generate-client-token": "Failed to  retrieve the client token",
  "blob.generate-presigned-url": "Failed to retrieve the presigned URL",
} as const satisfies Record<UploadRouteEventType, string>;

/** The SDK's messages for a 2xx route response whose body cannot be read. */
const routeBodyMessages = {
  "blob.generate-client-token": "Failed to retrieve the client token",
  "blob.generate-presigned-url": "Failed to retrieve the presigned URL",
} as const satisfies Record<UploadRouteEventType, string>;

const ClientTokenResponse = Schema.Struct({ clientToken: ClientTokenSchema });

const PresignedUrlResponse = Schema.Struct({
  presignedUrlPayload: Schema.optionalKey(Schema.NullOr(PresignedUrlPayload)),
});

const decodeAbsoluteUrl = Schema.decodeUnknownOption(Schema.URLFromString);

/**
 * The upload route's absolute URL, as the SDK's `isAbsoluteUrl`/`toAbsoluteUrl`: an absolute URL
 * is used as given, a relative one resolves against `globalThis.location.href` (pages and web
 * workers). A relative URL where there is no `location`, such as on a server, is a defect.
 */
const resolveUploadRouteUrl = (handleUploadUrl: string): Effect.Effect<string> =>
  Effect.suspend(() => {
    if (Option.isSome(decodeAbsoluteUrl(handleUploadUrl))) {
      return Effect.succeed(handleUploadUrl);
    }
    const location: unknown = Reflect.get(globalThis, "location");
    if (!Predicate.hasProperty(location, "href") || !Predicate.isString(location.href)) {
      return Effect.die(
        new Error(
          `Cannot resolve the relative handleUploadUrl "${handleUploadUrl}": there is no ` +
            "globalThis.location. Pass an absolute URL outside of browsers.",
        ),
      );
    }
    const base = location.href;
    return Effect.try({
      try: () => new URL(handleUploadUrl, base).href,
      catch: (cause) => cause,
    }).pipe(Effect.orDie);
  });

const withoutTracePropagation = Effect.provideService(HttpClient.TracerPropagationEnabled, false);

const clientTokenAuth = (token: ClientToken): BlobRequestAuth =>
  BlobRequestAuth.Bearer({
    token: Redacted.make(token),
    // The SDK sends an empty store id when the token has none.
    storeId: Option.getOrElse(storeIdFromClientToken(token), () => ""),
  });

const clientWriteHeaders = (options: {
  readonly access: BlobAccess;
  readonly contentType?: string | undefined;
}): Record<string, string> =>
  writeHeaders(allowedWriteOptions.client, {
    access: options.access,
    contentType: options.contentType,
  });

const makeBlobClient = Effect.fnUntraced(function* (options: BlobClientOptions) {
  const httpClient = yield* HttpClient.HttpClient;
  const requester = blobRequester(yield* resolveClientSettings(options, httpClient));

  /** The multipart engine with the client's write headers and domain errors, for one upload's auth. */
  const multipartTarget = (
    auth: BlobRequestAuth,
  ): Multipart.MultipartTarget<never, never, (typeof clientDomainErrors)[number]> => ({
    requester,
    auth: Effect.succeed(auth),
    service: "BlobClient",
    domainErrors: clientDomainErrors,
    writeOptions: Multipart.clientMultipartWriteOptions,
  });

  /** POST the event to the upload route, as the SDK's `retrieveClientToken` does. */
  const postUploadEvent = Effect.fnUntraced(function* (
    type: UploadRouteEventType,
    pathname: BlobPathname,
    options: ClientUploadOptions & UploadRouteOptions,
  ): Effect.fn.Return<
    { readonly status: number; readonly body: unknown },
    BlobUploadAuthorizationFailed
  > {
    const url = yield* resolveUploadRouteUrl(options.handleUploadUrl);
    const event = {
      type,
      payload: {
        pathname,
        clientPayload: options.clientPayload ?? null,
        multipart: options.multipart ?? false,
      },
    };
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(JSON.stringify(event), "application/json"),
      HttpClientRequest.setHeaders({ "content-type": "application/json", ...options.headers }),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new BlobUploadAuthorizationFailed({
            status: Option.none(),
            message: routeFailedMessages[type],
            cause,
          }),
      ),
      withoutTracePropagation,
    );
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.ignore(response.arrayBuffer);
      return yield* new BlobUploadAuthorizationFailed({
        status: Option.some(response.status),
        message: routeFailedMessages[type],
      });
    }
    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new BlobUploadAuthorizationFailed({
            status: Option.some(response.status),
            message: routeBodyMessages[type],
            cause,
          }),
      ),
    );
    return { status: response.status, body };
  });

  const retrieveClientToken = Effect.fnUntraced(function* (
    pathname: BlobPathname,
    options: ClientUploadOptions & UploadRouteOptions,
  ): Effect.fn.Return<ClientToken, BlobUploadAuthorizationFailed> {
    const type = "blob.generate-client-token";
    const { status, body } = yield* postUploadEvent(type, pathname, options);
    const decoded = yield* Schema.decodeUnknownEffect(ClientTokenResponse)(body).pipe(
      Effect.mapError(
        (cause) =>
          new BlobUploadAuthorizationFailed({
            status: Option.some(status),
            message: routeBodyMessages[type],
            cause,
          }),
      ),
    );
    return decoded.clientToken;
  });

  const retrievePresignedAuth = Effect.fnUntraced(function* (
    pathname: BlobPathname,
    options: ClientUploadOptions & UploadRouteOptions,
  ): Effect.fn.Return<BlobRequestAuth, BlobUploadAuthorizationFailed> {
    const type = "blob.generate-presigned-url";
    const { status, body } = yield* postUploadEvent(type, pathname, options);
    const fail = (message: string, cause?: unknown) =>
      new BlobUploadAuthorizationFailed({ status: Option.some(status), message, cause });
    const decoded = yield* Schema.decodeUnknownEffect(PresignedUrlResponse)(body).pipe(
      Effect.mapError((cause) => fail(routeBodyMessages[type], cause)),
    );
    const payload = decoded.presignedUrlPayload;
    if (payload === undefined || payload === null) {
      return yield* fail("Missing presignedUrlPayload");
    }
    const storeId = storeIdFromDelegationToken(payload.delegationToken);
    if (Option.isNone(storeId)) {
      return yield* fail(
        payload.delegationToken.includes(".")
          ? "Invalid delegation token payload."
          : "Invalid delegation token format.",
      );
    }
    return BlobRequestAuth.Presigned({ payload, storeId: storeId.value });
  });

  /** `PUT /?pathname=…` with the client write headers, or automatic multipart. */
  const send = <E, R>(
    operation: string,
    auth: BlobRequestAuth,
    pathname: BlobPathname,
    body: BlobBody<E, R>,
    options: ClientUploadOptions,
  ): Effect.Effect<PutBlobResult, BlobClientError | E, R> => {
    if (options.multipart === true) {
      return Multipart.multipartPut(multipartTarget(auth), pathname, body, {
        access: options.access,
        contentType: options.contentType,
        onUploadProgress: options.onUploadProgress,
      });
    }
    const headers = clientWriteHeaders(options);
    return requester.call({
      operation,
      method: "PUT",
      path: `/?${new URLSearchParams({ pathname }).toString()}`,
      auth: Effect.succeed(auth),
      headers,
      body,
      response: PutBlobResponse,
      domainErrors: clientDomainErrors,
      onUploadProgress: options.onUploadProgress,
      progressInterval: singleUploadProgressInterval,
    });
  };

  const upload = Effect.fn("BlobClient.upload")(function* <E = never, R = never>(
    pathname: BlobPathname,
    body: BlobBody<E, R>,
    options: ClientUploadOptions & UploadRouteOptions,
  ): Effect.fn.Return<PutBlobResult, BlobClientError | BlobUploadAuthorizationFailed | E, R> {
    const token = yield* retrieveClientToken(pathname, options);
    return yield* send("BlobClient.upload", clientTokenAuth(token), pathname, body, options);
  });

  const uploadPresigned = Effect.fn("BlobClient.uploadPresigned")(function* <E = never, R = never>(
    pathname: BlobPathname,
    body: BlobBody<E, R>,
    options: ClientUploadOptions & UploadRouteOptions,
  ): Effect.fn.Return<PutBlobResult, BlobClientError | BlobUploadAuthorizationFailed | E, R> {
    const auth = yield* retrievePresignedAuth(pathname, options);
    return yield* send("BlobClient.uploadPresigned", auth, pathname, body, options);
  });

  const put = Effect.fn("BlobClient.put")(function* <E = never, R = never>(
    pathname: BlobPathname,
    body: BlobBody<E, R>,
    options: ClientUploadOptions & { readonly token: ClientToken },
  ): Effect.fn.Return<PutBlobResult, BlobClientError | E, R> {
    return yield* send("BlobClient.put", clientTokenAuth(options.token), pathname, body, options);
  });

  const createMultipartUpload = Effect.fn("BlobClient.createMultipartUpload")(function* (
    pathname: BlobPathname,
    options: {
      readonly token: ClientToken;
      readonly access: BlobAccess;
      readonly contentType?: string | undefined;
    },
  ): Effect.fn.Return<MultipartUpload, BlobClientError> {
    return yield* Multipart.createMultipartUpload(
      multipartTarget(clientTokenAuth(options.token)),
      pathname,
      { access: options.access, contentType: options.contentType },
    );
  });

  const uploadPart = Effect.fn("BlobClient.uploadPart")(function* <E = never, R = never>(
    upload: MultipartUpload,
    partNumber: PartNumber,
    body: BlobBody<E, R>,
    options: { readonly token: ClientToken },
  ): Effect.fn.Return<UploadedPart, BlobClientError | E, R> {
    return yield* Multipart.uploadPart(
      multipartTarget(clientTokenAuth(options.token)),
      upload,
      partNumber,
      body,
    );
  });

  const completeMultipartUpload = Effect.fn("BlobClient.completeMultipartUpload")(function* (
    upload: MultipartUpload,
    parts: Array.NonEmptyReadonlyArray<UploadedPart>,
    options: { readonly token: ClientToken },
  ): Effect.fn.Return<PutBlobResult, BlobClientError> {
    return yield* Multipart.completeMultipartUpload(
      multipartTarget(clientTokenAuth(options.token)),
      upload,
      parts,
    );
  });

  return BlobClient.of({
    upload,
    uploadPresigned,
    put,
    createMultipartUpload,
    uploadPart,
    completeMultipartUpload,
  });
});

/**
 * Builds {@link BlobClient} over the given `HttpClient`, with any given values taking precedence
 * over the environment.
 *
 * Reads, through `Config` (trimmed, blank means absent): `VERCEL_BLOB_API_URL` or
 * `NEXT_PUBLIC_VERCEL_BLOB_API_URL`, `VERCEL_BLOB_API_VERSION_OVERRIDE` or its `NEXT_PUBLIC_` twin
 * (default `13`), `VERCEL_BLOB_RETRIES` (default 10), `VERCEL_BLOB_USE_X_CONTENT_LENGTH`, and
 * `VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API` or its `NEXT_PUBLIC_` twin. In browsers these are
 * usually absent or inlined `NEXT_PUBLIC_*` values, so the defaults apply.
 *
 * Uploads through an upload route with a relative `handleUploadUrl` need `globalThis.location`
 * (pages and web workers); elsewhere that is a defect, so pass an absolute URL.
 *
 * Fails with a `ConfigError` when the API URL or `VERCEL_BLOB_RETRIES` is invalid.
 */
export const blobClientLayer = (
  options: BlobClientOptions = {},
): Layer.Layer<BlobClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(BlobClient, makeBlobClient(options));

/** {@link BlobClient} configured from the environment; needs an `HttpClient`. */
export const BlobClientLive: Layer.Layer<BlobClient, Config.ConfigError, HttpClient.HttpClient> =
  blobClientLayer();
