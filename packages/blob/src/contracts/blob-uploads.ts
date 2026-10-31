import type { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";

import { Context } from "effect";

import type {
  ClientToken,
  ClientTokenConstraints,
  UploadCompleted,
  UploadRequest,
} from "./blob-domain.ts";
import type {
  BlobPresignFailed,
  BlobReadWriteTokenRequired,
  BlobUploadEventRejected,
} from "./blob-errors.ts";
import type { PresignOptions, SigningToken } from "./blob-signed-urls.ts";

/** Callback the store calls after a browser upload completes. */
export interface UploadCompletedCallback {
  /** Absolute URL of the route that handles `blob.upload-completed`. */
  readonly callbackUrl: string;

  /** Data passed back to the callback, such as the uploading user's id. */
  readonly tokenPayload?: string | undefined;
}

/** Everything a client token encodes. */
export type ClientTokenOptions = ClientTokenConstraints & {
  /** The only pathname the token may upload to. */
  readonly pathname: string;

  readonly onUploadCompleted?: UploadCompletedCallback | undefined;
};

/** What an upload route allows for one browser upload; returned by `onBeforeGenerateToken`. */
export type UploadAuthorization = ClientTokenConstraints & {
  /** Passed to `onUploadCompleted`; defaults to the browser's `clientPayload`. */
  readonly tokenPayload?: string | undefined;

  /**
   * Where the upload-completed callback goes. Derived from the environment when omitted:
   * `VERCEL_BLOB_CALLBACK_URL`, else the preview or production URL on Vercel, plus this route's
   * path. Never taken from the browser.
   */
  readonly callbackUrl?: string | undefined;
};

/** Hooks of a client-token upload route. */
export interface UploadHandlerOptions<E, R, E2, R2> {
  /**
   * Authenticate and authorize the user, then constrain the upload. Fail to refuse it; the error
   * leaves the handler so the route can answer 401 or 403.
   */
  readonly onBeforeGenerateToken: (
    request: UploadRequest,
  ) => Effect.Effect<UploadAuthorization, E, R>;

  /**
   * Runs when the store reports the upload finished, after the callback's signature is verified.
   * Without it no callback is requested. Fail to make the store retry the callback.
   */
  readonly onUploadCompleted?:
    | ((event: UploadCompleted) => Effect.Effect<void, E2, R2>)
    | undefined;
}

/** What a presigned upload route allows for one browser upload; returned by `getSignedToken`. */
export interface PresignedUploadAuthorization {
  /** Token to sign the upload URL with, usually cached by the route. */
  readonly token: SigningToken;

  /** Constraints signed into the URL; they may only narrow the token's. */
  readonly urlOptions?:
    | (Omit<
        Extract<PresignOptions, { readonly operation: "put" }>,
        "operation" | "pathname" | "onUploadCompleted"
      > & {
        /** As {@link UploadAuthorization.callbackUrl}. */
        readonly callbackUrl?: string | undefined;
        /** Passed to `onUploadCompleted`; defaults to the browser's `clientPayload`. */
        readonly tokenPayload?: string | undefined;
      })
    | undefined;
}

/** Hooks of a presigned upload route. */
export interface PresignedUploadHandlerOptions<E, R, E2, R2> {
  /** Authenticate and authorize the user, then choose the token and constraints. */
  readonly getSignedToken: (
    request: UploadRequest,
  ) => Effect.Effect<PresignedUploadAuthorization, E, R>;

  /** As {@link UploadHandlerOptions.onUploadCompleted}; callbacks are verified with Ed25519. */
  readonly onUploadCompleted?:
    | ((event: UploadCompleted) => Effect.Effect<void, E2, R2>)
    | undefined;
}

/**
 * The server side of browser uploads: a route that authorizes uploads and receives the store's
 * upload-completed callbacks.
 *
 * ```ts
 * export const POST = HttpEffect.toWebHandlerLayer(
 *   BlobUploads.use((uploads) =>
 *     uploads.handler({ onBeforeGenerateToken: authorize, onUploadCompleted: saveAvatar }),
 *   ).pipe(Effect.catchTag("Unauthorized", () => HttpServerResponse.empty({ status: 401 }))),
 *   AppLayer,
 * ).handler;
 * ```
 */
export class BlobUploads extends Context.Service<
  BlobUploads,
  {
    /**
     * Sign a client token with the store's read-write token. Defaults `validUntil` to 30 seconds
     * from now; an `ifMatch` without `allowOverwrite` allows overwriting.
     */
    readonly generateClientToken: (
      options: ClientTokenOptions,
    ) => Effect.Effect<ClientToken, BlobReadWriteTokenRequired>;

    /**
     * Handle one request to a client-token upload route (`handleUpload`): answer
     * `blob.generate-client-token` with `{ type, clientToken }` (valid for one hour unless
     * `validUntil` says otherwise) and acknowledge a verified `blob.upload-completed` with
     * `{ type, response: "ok" }`. Requires a read-write token.
     */
    readonly handler: <E, R, E2 = never, R2 = never>(
      options: UploadHandlerOptions<E, R, E2, R2>,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E | E2 | BlobUploadEventRejected | BlobReadWriteTokenRequired,
      HttpServerRequest.HttpServerRequest | R | R2
    >;

    /**
     * Handle one request to a presigned upload route (`handleUploadPresigned`): answer
     * `blob.generate-presigned-url` with `{ type, presignedUrlPayload }` and acknowledge a
     * `blob.upload-completed` verified against `BLOB_WEBHOOK_PUBLIC_KEY`. Works with OIDC.
     */
    readonly presignedHandler: <E, R, E2 = never, R2 = never>(
      options: PresignedUploadHandlerOptions<E, R, E2, R2>,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E | E2 | BlobUploadEventRejected | BlobPresignFailed,
      HttpServerRequest.HttpServerRequest | R | R2
    >;
  }
>()("@effect-vercel/blob/BlobUploads") {}
