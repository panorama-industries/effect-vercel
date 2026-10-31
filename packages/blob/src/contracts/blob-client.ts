import type { VercelApiError } from "@panorama-industries/effect-vercel-core";
import type { Array, Effect } from "effect";

import { Context } from "effect";

import type {
  BlobAccess,
  BlobBody,
  BlobPathname,
  ClientToken,
  MultipartUpload,
  OnUploadProgress,
  PartNumber,
  PutBlobResult,
  UploadedPart,
} from "./blob-domain.ts";
import type {
  BlobClientTokenNotAllowed,
  BlobPreconditionFailed,
  BlobStoreUnavailable,
  BlobUploadAuthorizationFailed,
  BlobUploadRejected,
} from "./blob-errors.ts";

/** Failures of uploading from a browser with a client token or presigned URL. */
export type BlobClientError =
  | VercelApiError
  | BlobStoreUnavailable
  | BlobUploadRejected
  | BlobPreconditionFailed
  | BlobClientTokenNotAllowed;

/**
 * Options a browser may set on an upload. Overwriting, random suffixes and cache lifetime are
 * decided by the server when it authorizes the upload.
 */
export interface ClientUploadOptions {
  /** Must match the store's access mode. */
  readonly access: BlobAccess;

  readonly contentType?: string | undefined;

  /** Upload in 8 MiB parts, six at a time; use it for large files. */
  readonly multipart?: boolean | undefined;

  /**
   * Byte-level progress where `fetch` can stream request bodies (Chromium); elsewhere 0 % before
   * the upload, one event per finished part, and 100 % at the end.
   */
  readonly onUploadProgress?: OnUploadProgress | undefined;
}

/** How a browser asks the application's upload route to authorize an upload. */
export interface UploadRouteOptions {
  /** The upload route, absolute or relative to the page. */
  readonly handleUploadUrl: string;

  /** Sent to the route's `onBeforeGenerateToken` or `getSignedToken`; untrusted there. */
  readonly clientPayload?: string | undefined;

  /** Extra headers for the request to the upload route, such as an anti-CSRF token. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * Browser uploads straight to Vercel Blob, bypassing the 4.5 MB function body limit. The
 * application's upload route (see `BlobUploads`) authorizes each upload.
 *
 * Import from `@panorama-industries/effect-vercel-blob/client`. `BlobClientLive` needs only an
 * `HttpClient`, such as `FetchHttpClient.layer`.
 */
export class BlobClient extends Context.Service<
  BlobClient,
  {
    /** Get a client token from the upload route, then upload with it. */
    readonly upload: <E = never, R = never>(
      pathname: BlobPathname,
      body: BlobBody<E, R>,
      options: ClientUploadOptions & UploadRouteOptions,
    ) => Effect.Effect<PutBlobResult, BlobClientError | BlobUploadAuthorizationFailed | E, R>;

    /** Get a presigned URL from the upload route, then upload with it; sends no credentials. */
    readonly uploadPresigned: <E = never, R = never>(
      pathname: BlobPathname,
      body: BlobBody<E, R>,
      options: ClientUploadOptions & UploadRouteOptions,
    ) => Effect.Effect<PutBlobResult, BlobClientError | BlobUploadAuthorizationFailed | E, R>;

    /** Upload with a client token the application obtained itself. */
    readonly put: <E = never, R = never>(
      pathname: BlobPathname,
      body: BlobBody<E, R>,
      options: ClientUploadOptions & { readonly token: ClientToken },
    ) => Effect.Effect<PutBlobResult, BlobClientError | E, R>;

    /** Start a multipart upload with a client token issued for multipart uploads. */
    readonly createMultipartUpload: (
      pathname: BlobPathname,
      options: {
        readonly token: ClientToken;
        readonly access: BlobAccess;
        readonly contentType?: string | undefined;
      },
    ) => Effect.Effect<MultipartUpload, BlobClientError>;

    /** Upload one part of a multipart upload. */
    readonly uploadPart: <E = never, R = never>(
      upload: MultipartUpload,
      partNumber: PartNumber,
      body: BlobBody<E, R>,
      options: { readonly token: ClientToken },
    ) => Effect.Effect<UploadedPart, BlobClientError | E, R>;

    /** Assemble the uploaded parts into the blob. */
    readonly completeMultipartUpload: (
      upload: MultipartUpload,
      parts: Array.NonEmptyReadonlyArray<UploadedPart>,
      options: { readonly token: ClientToken },
    ) => Effect.Effect<PutBlobResult, BlobClientError>;
  }
>()("@effect-vercel/blob/BlobClient") {}
