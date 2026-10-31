import type { VercelApiError } from "@panorama-industries/effect-vercel-core";
import type { DateTime, Duration, Effect, Stream } from "effect";

import { Data, Schema } from "effect";

/** Whether a blob is readable by anyone with its URL (`public`) or only with credentials. */
export const BlobAccess = Schema.Literals(["public", "private"]);

/** Whether a blob is readable by anyone with its URL (`public`) or only with credentials. */
export type BlobAccess = typeof BlobAccess.Type;

/**
 * Identifier of a Blob store without its `store_` prefix, as sent in `x-vercel-blob-store-id` and
 * used in blob host names. Case-sensitive.
 */
export const StoreId = Schema.String.check(Schema.isPattern(/^(?!store_)[^\s_]+$/)).pipe(
  Schema.brand("StoreId"),
);

/** Identifier of a Blob store without its `store_` prefix. */
export type StoreId = typeof StoreId.Type;

/** Longest pathname a write accepts: the provider limit minus room for Vercel's suffixes. */
export const maximumPathnameLength = 950;

/**
 * Where a write stores a blob inside its store, such as `avatars/user-1.png`: non-empty, at most
 * {@link maximumPathnameLength} characters, and without `//`.
 *
 * Reads and deletes take any pathname or blob URL as a plain string, because stored pathnames may
 * be longer once a random suffix is added.
 */
export const BlobPathname = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumPathnameLength),
  Schema.makeFilter((pathname: string) => !pathname.includes("//"), {
    expected: 'a pathname without "//"',
  }),
).pipe(Schema.brand("BlobPathname"));

/** Where a write stores a blob inside its store. */
export type BlobPathname = typeof BlobPathname.Type;

/** A blob to read or delete: its pathname in the store, or its full URL. */
export type BlobLocator = string | URL;

/** Version tag of a blob's content, used for conditional writes, deletes and reads. */
export const ETag = Schema.NonEmptyString.pipe(Schema.brand("ETag"));

/** Version tag of a blob's content. */
export type ETag = typeof ETag.Type;

/** Position of a part in a multipart upload: an integer from 1 to 10000. */
export const PartNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })).pipe(
  Schema.brand("PartNumber"),
);

/** Position of a part in a multipart upload: an integer from 1 to 10000. */
export type PartNumber = typeof PartNumber.Type;

/**
 * Content to upload. A stream is sent as it is produced; its failures and requirements become the
 * operation's. Convert a Node `Readable` with `NodeStream.fromReadable` and a web `ReadableStream`
 * with `Stream.fromReadableStream`.
 */
export type BlobBody<E = never, R = never> =
  | string
  | Uint8Array
  | globalThis.Blob
  | Stream.Stream<Uint8Array, E, R>;

/** Bytes sent so far during an upload. */
export interface UploadProgress {
  readonly loaded: number;

  /** Bytes to send in total; equals `loaded` when the size of a streamed body is unknown. */
  readonly total: number;

  /** Completion from 0 to 100 with two decimals; 100 is reported only once the upload finished. */
  readonly percentage: number;
}

/** Callback for upload progress events, throttled like `@vercel/blob`. */
export type OnUploadProgress = (progress: UploadProgress) => Effect.Effect<void>;

/**
 * Whether a write may replace an existing blob. Either set `allowOverwrite`, or make the write
 * conditional with `ifMatch`, which implies overwriting.
 */
export type OverwriteOptions =
  | {
      /** Replace a blob already stored at the pathname instead of failing. Defaults to false. */
      readonly allowOverwrite?: boolean | undefined;
      readonly ifMatch?: undefined;
    }
  | {
      readonly allowOverwrite?: true | undefined;
      /** Write only if the current blob has this ETag; otherwise fail with `BlobPreconditionFailed`. */
      readonly ifMatch: ETag;
    };

/** Options shared by every operation that creates a blob. */
export type CreateBlobOptions = OverwriteOptions & {
  readonly access: BlobAccess;

  /** Append a random suffix to the pathname so it never collides. */
  readonly addRandomSuffix?: boolean | undefined;

  /** Media type served with the blob; inferred from the pathname extension by default. */
  readonly contentType?: string | undefined;

  /** How long browsers and the CDN cache the blob: at least one minute, one month by default. */
  readonly cacheControlMaxAge?: Duration.Input | undefined;
};

/** A stored blob as returned by writes. */
export class PutBlobResult extends Schema.Class<PutBlobResult>("@effect-vercel/blob/PutBlobResult")(
  {
    url: Schema.URL,
    /** The URL with `?download=1`, which makes browsers download instead of display. */
    downloadUrl: Schema.URL,
    pathname: Schema.String,
    contentType: Schema.String,
    contentDisposition: Schema.String,
    etag: ETag,
  },
) {}

/** Everything known about a stored blob. */
export class BlobMetadata extends Schema.Class<BlobMetadata>("@effect-vercel/blob/BlobMetadata")({
  url: Schema.URL,
  downloadUrl: Schema.URL,
  pathname: Schema.String,
  /** Size in bytes. */
  size: Schema.Int,
  uploadedAt: Schema.DateTimeUtc,
  contentType: Schema.String,
  contentDisposition: Schema.String,
  cacheControl: Schema.String,
  etag: ETag,
}) {}

/** One entry of a listing. */
export class ListedBlob extends Schema.Class<ListedBlob>("@effect-vercel/blob/ListedBlob")({
  url: Schema.URL,
  downloadUrl: Schema.URL,
  pathname: Schema.String,
  size: Schema.Int,
  uploadedAt: Schema.DateTimeUtc,
  etag: ETag,
}) {}

/** One page of a listing, in lexicographic pathname order. */
export class ListPage extends Schema.Class<ListPage>("@effect-vercel/blob/ListPage")({
  blobs: Schema.Array(ListedBlob),
  /** Fully qualified folder pathnames directly under the prefix; empty unless `mode` is `folded`. */
  folders: Schema.Array(Schema.String),
  /** Pass to the next `list` call to continue; none on the last page. */
  cursor: Schema.Option(Schema.String),
  hasMore: Schema.Boolean,
}) {}

/** A folder created with `createFolder`. */
export class CreateFolderResult extends Schema.Class<CreateFolderResult>(
  "@effect-vercel/blob/CreateFolderResult",
)({
  url: Schema.URL,
  /** The folder pathname, ending in `/`. */
  pathname: Schema.String,
}) {}

/** Metadata of a blob read with `get`, from its response headers. */
export class FetchedBlob extends Schema.Class<FetchedBlob>("@effect-vercel/blob/FetchedBlob")({
  url: Schema.URL,
  downloadUrl: Schema.URL,
  pathname: Schema.String,
  contentDisposition: Schema.String,
  cacheControl: Schema.String,
  /** `Last-Modified`, or the time of the read when the response had none. */
  uploadedAt: Schema.DateTimeUtc,
  etag: Schema.String,
}) {}

/** Outcome of `get`. */
export type GetBlobResult = Data.TaggedEnum<{
  /** The blob's content (HTTP 200). */
  Found: {
    readonly blob: FetchedBlob;
    readonly contentType: string;
    /** `Content-Length`, or 0 when the response had none. */
    readonly size: number;
    /** Response headers, for anything not in `blob`. */
    readonly headers: Readonly<Record<string, string>>;
    /** The content, read as it arrives. Read it at most once. */
    readonly body: Stream.Stream<Uint8Array, VercelApiError>;
  };
  /** The blob still has the ETag given as `ifNoneMatch` (HTTP 304). */
  NotModified: {
    readonly blob: FetchedBlob;
    readonly headers: Readonly<Record<string, string>>;
  };
}>;

/** Constructors and matchers for {@link GetBlobResult}. */
export const GetBlobResult = Data.taggedEnum<GetBlobResult>();

/**
 * A multipart upload in progress. Every write option is kept so parts and completion send the same
 * headers as creation; the value can be serialized and resumed by another process.
 */
export class MultipartUpload extends Schema.Class<MultipartUpload>(
  "@effect-vercel/blob/MultipartUpload",
)({
  pathname: BlobPathname,
  /** Identifies the blob object being assembled. */
  key: Schema.String,
  uploadId: Schema.String,
  access: BlobAccess,
  addRandomSuffix: Schema.optionalKey(Schema.Boolean),
  allowOverwrite: Schema.optionalKey(Schema.Boolean),
  contentType: Schema.optionalKey(Schema.String),
  /** In seconds, as sent on the wire. */
  cacheControlMaxAge: Schema.optionalKey(Schema.Int),
}) {}

/** A part uploaded to a multipart upload, needed to complete it. */
export class UploadedPart extends Schema.Class<UploadedPart>("@effect-vercel/blob/UploadedPart")({
  etag: Schema.String,
  partNumber: PartNumber,
}) {}

/** Operations a signed token can delegate. */
export const DelegationOperation = Schema.Literals(["get", "head", "put", "delete"]);

/** Operations a signed token can delegate. */
export type DelegationOperation = typeof DelegationOperation.Type;

/** Query parameters that authorize one presigned request instead of a bearer token. */
export class PresignedUrlPayload extends Schema.Class<PresignedUrlPayload>(
  "@effect-vercel/blob/PresignedUrlPayload",
)({
  /** Public part of the signed token; the store id is read from it. */
  delegationToken: Schema.String,
  /** HMAC-SHA256 (base64url) of the request's canonical string, keyed by the client signing token. */
  signature: Schema.String,
  /** Signed constraints, sent as query parameters. */
  params: Schema.Record(Schema.String, Schema.String),
}) {}

/** A short-lived token, issued by the Blob API, from which presigned URLs are signed locally. */
export class SignedToken extends Schema.Class<SignedToken>("@effect-vercel/blob/SignedToken")({
  /** Public; embedded in every presigned URL. */
  delegationToken: Schema.String,
  /** Secret HMAC key for presigning. Never send it to clients. */
  clientSigningToken: Schema.Redacted(Schema.String),
  validUntil: Schema.DateTimeUtc,
}) {}

/** A token that lets a browser upload one pathname directly (`vercel_blob_client_…`). */
export const ClientToken = Schema.String.check(Schema.isPattern(/^vercel_blob_client_/)).pipe(
  Schema.brand("ClientToken"),
);

/** A token that lets a browser upload one pathname directly. */
export type ClientToken = typeof ClientToken.Type;

/** Constraints a server places on a browser upload when it issues a client token. */
export interface ClientTokenConstraints {
  /** Largest accepted file, at most 5 TB. */
  readonly maximumSizeInBytes?: number | undefined;

  /** Accepted media types; wildcards such as `image/*` are allowed. */
  readonly allowedContentTypes?: ReadonlyArray<string> | undefined;

  /** Expiry; defaults depend on the caller (one hour for upload routes). */
  readonly validUntil?: DateTime.Utc | undefined;

  readonly addRandomSuffix?: boolean | undefined;
  readonly allowOverwrite?: boolean | undefined;

  /** In seconds. */
  readonly cacheControlMaxAge?: number | undefined;

  readonly ifMatch?: ETag | undefined;
}

/** The blob store's notification that a browser upload finished. */
export class UploadCompleted extends Schema.Class<UploadCompleted>(
  "@effect-vercel/blob/UploadCompleted",
)({
  blob: PutBlobResult,
  /** Data the server attached when it authorized the upload. */
  tokenPayload: Schema.Option(Schema.String),
}) {}

/** What a browser asks for when it starts an upload through an upload route. */
export class UploadRequest extends Schema.Class<UploadRequest>("@effect-vercel/blob/UploadRequest")(
  {
    pathname: Schema.String,
    /** Data the browser sent along, such as a form id; untrusted. */
    clientPayload: Schema.Option(Schema.String),
    multipart: Schema.Boolean,
  },
) {}
