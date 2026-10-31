import type { Array, DateTime, Effect } from "effect";

import { Context } from "effect";

import type {
  BlobAccess,
  DelegationOperation,
  ETag,
  PresignedUrlPayload,
  SignedToken,
} from "./blob-domain.ts";
import type { BlobPresignFailed } from "./blob-errors.ts";
import type { BlobRequestError } from "./blob-store.ts";

/** Scope of a signed token. Every field narrows what presigned URLs signed from it may do. */
export interface IssueSignedTokenOptions {
  /** Pathname the token covers; `*` or omitted covers the whole store. */
  readonly pathname?: string | undefined;

  /** Operations the token delegates; the store defaults to `get`. Duplicates are removed. */
  readonly operations?: Array.NonEmptyReadonlyArray<DelegationOperation> | undefined;

  /** Expiry, in the future and at most 7 days away; the store defaults to one hour. */
  readonly validUntil?: DateTime.Utc | undefined;

  /** Largest upload a presigned `put` may send. */
  readonly maximumSizeInBytes?: number | undefined;

  /** Media types a presigned `put` may upload; wildcards such as `image/*` are allowed. */
  readonly allowedContentTypes?: ReadonlyArray<string> | undefined;
}

/** Callback the store calls after a presigned upload completes. */
export interface PresignUploadCompleted {
  /** Absolute URL of the route that handles `blob.upload-completed`. */
  readonly callbackUrl: string;

  /** Data passed back to the callback, such as the uploading user's id. */
  readonly tokenPayload?: string | undefined;
}

/** What one presigned URL authorizes. Constraints may only narrow the signed token's. */
export type PresignOptions =
  | {
      readonly operation: "get";
      readonly pathname: string;
      /** Earlier expiry than the token's. */
      readonly validUntil?: DateTime.Utc | undefined;
      /** Add `cache=0` to read a private blob from origin storage; not signed. */
      readonly useCache?: boolean | undefined;
    }
  | {
      readonly operation: "head";
      readonly pathname: string;
      readonly validUntil?: DateTime.Utc | undefined;
    }
  | {
      readonly operation: "put";
      readonly pathname: string;
      readonly validUntil?: DateTime.Utc | undefined;
      readonly allowedContentTypes?: ReadonlyArray<string> | undefined;
      readonly maximumSizeInBytes?: number | undefined;
      readonly onUploadCompleted?: PresignUploadCompleted | undefined;
      readonly allowOverwrite?: boolean | undefined;
      readonly addRandomSuffix?: boolean | undefined;
      /** In seconds, at most one year. */
      readonly cacheControlMaxAge?: number | undefined;
      readonly ifMatch?: ETag | undefined;
    }
  | {
      readonly operation: "delete";
      readonly pathname: string;
      readonly validUntil?: DateTime.Utc | undefined;
      readonly ifMatch?: ETag | undefined;
    };

/** The secret and public halves of a signed token, as needed to presign. */
export type SigningToken = Pick<SignedToken, "delegationToken" | "clientSigningToken">;

/**
 * Signed URLs: delegate one operation on one pathname to a holder of a URL, without credentials.
 *
 * Issue a {@link SignedToken} once (one API call) and cache it until shortly before it expires;
 * presigning is local HMAC-SHA256 signing.
 */
export class BlobSignedUrls extends Context.Service<
  BlobSignedUrls,
  {
    /** Ask the store for a signed token (`POST /signed-token`). */
    readonly issueSignedToken: (
      options?: IssueSignedTokenOptions,
    ) => Effect.Effect<SignedToken, BlobRequestError>;

    /**
     * Sign one request. Fails with `BlobPresignFailed` when the token has expired, does not delegate
     * the operation, covers another pathname, or allows less than the options ask for.
     */
    readonly presign: (
      token: SigningToken,
      options: PresignOptions,
    ) => Effect.Effect<PresignedUrlPayload, BlobPresignFailed>;

    /**
     * Sign one request and build its URL: the blob URL for `get` and `head`, the Blob API URL for
     * `put` and `delete`.
     */
    readonly presignUrl: (
      token: SigningToken,
      options: PresignOptions & { readonly access: BlobAccess },
    ) => Effect.Effect<URL, BlobPresignFailed>;
  }
>()("@effect-vercel/blob/BlobSignedUrls") {}
