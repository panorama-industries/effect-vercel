import type { OidcTokenUnavailable, VercelApiError } from "@panorama-industries/effect-vercel-core";
import type { Array, Effect, Stream } from "effect";

import { Context, Schema } from "effect";

import type {
  BlobAccess,
  BlobBody,
  BlobLocator,
  BlobMetadata,
  BlobPathname,
  CreateBlobOptions,
  CreateFolderResult,
  ETag,
  GetBlobResult,
  ListedBlob,
  ListPage,
  MultipartUpload,
  OnUploadProgress,
  PartNumber,
  PutBlobResult,
  UploadedPart,
} from "./blob-domain.ts";
import type {
  BlobNotFound,
  BlobOidcEnvironmentNotAllowed,
  BlobPreconditionFailed,
  BlobStoreUnavailable,
  BlobUploadRejected,
} from "./blob-errors.ts";

/** Failures every Blob API call can report. */
export type BlobRequestError =
  | VercelApiError
  | BlobStoreUnavailable
  | BlobOidcEnvironmentNotAllowed
  | OidcTokenUnavailable;

/** Failures of creating or replacing a blob. */
export type BlobWriteError = BlobRequestError | BlobPreconditionFailed | BlobUploadRejected;

/** Options for {@link BlobStore} `put`. */
export type PutOptions = CreateBlobOptions & {
  /**
   * Upload in 8 MiB parts, eight at a time, instead of one request. Use it for large bodies; parts
   * are produced from the body as it streams, so memory stays bounded.
   */
  readonly multipart?: boolean | undefined;

  /**
   * Refuse a multipart upload whose known size exceeds this many bytes before sending anything.
   * Streams of unknown size are not checked.
   */
  readonly maximumSizeInBytes?: number | undefined;

  readonly onUploadProgress?: OnUploadProgress | undefined;
};

/** Width of an optimized image in pixels: an integer from 1 to 8192. */
export const ImageWidth = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })).pipe(
  Schema.brand("ImageWidth"),
);

/** Width of an optimized image in pixels. */
export type ImageWidth = typeof ImageWidth.Type;

/** Quality of an optimized image: an integer from 1 to 100. */
export const ImageQuality = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
  Schema.brand("ImageQuality"),
);

/** Quality of an optimized image: an integer from 1 to 100. */
export type ImageQuality = typeof ImageQuality.Type;

/** Output format of an optimized image. */
export const ImageFormat = Schema.Literals(["jpeg", "png", "webp", "avif"]);

/** Output format of an optimized image. */
export type ImageFormat = typeof ImageFormat.Type;

/** How Vercel Image Optimization transforms an image before it is stored. */
export interface ImageOptimization {
  readonly width: ImageWidth;

  /** Defaults to 75. */
  readonly quality?: ImageQuality | undefined;

  /** Defaults to the source format. */
  readonly format?: ImageFormat | undefined;
}

/** Options for {@link BlobStore} `putImage`; the stored media type comes from the optimizer. */
export type PutImageOptions = Omit<CreateBlobOptions, "contentType"> & {
  readonly optimizeImage: ImageOptimization;
  readonly onUploadProgress?: OnUploadProgress | undefined;
};

/** Options for {@link BlobStore} `get`. */
export interface GetOptions {
  readonly access: BlobAccess;

  /**
   * When false, read a private blob from origin storage instead of the CDN cache: always the latest
   * content, but slower. Ignored for public blobs.
   */
  readonly useCache?: boolean | undefined;

  /** Return `NotModified` instead of the content when the blob still has this ETag. */
  readonly ifNoneMatch?: string | undefined;

  /** Extra request headers; they override the defaults, including `authorization`. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** Options for {@link BlobStore} `list` and `listAll`. */
export interface ListOptions {
  /** Entries per page; the store's default and maximum is 1000. */
  readonly limit?: number | undefined;

  /** Only blobs whose pathname starts with this. */
  readonly prefix?: string | undefined;

  /**
   * `folded` returns the folders directly under `prefix` in `folders` and only the blobs at that
   * level in `blobs`.
   */
  readonly mode?: "expanded" | "folded" | undefined;
}

/** Options for {@link BlobStore} `createMultipartUpload`. */
export type CreateMultipartUploadOptions = CreateBlobOptions;

/**
 * The Vercel Blob server API: upload, read, list, copy, rename and delete blobs in one store.
 *
 * Credentials and endpoints come from `BlobConfig`.
 */
export class BlobStore extends Context.Service<
  BlobStore,
  {
    /**
     * Store a blob at `pathname`. The store refuses an existing pathname unless `allowOverwrite`
     * or `ifMatch` is set; a different ETag than `ifMatch` fails with `BlobPreconditionFailed`.
     */
    readonly put: <E = never, R = never>(
      pathname: BlobPathname,
      body: BlobBody<E, R>,
      options: PutOptions,
    ) => Effect.Effect<PutBlobResult, BlobWriteError | E, R>;

    /**
     * Optimize an image with Vercel Image Optimization and store only the result. The source is
     * the image content, or a `URL` the store fetches itself. Requires OIDC credentials. A source
     * whose known media type is not an image fails with `BlobUploadRejected` before any request.
     */
    readonly putImage: <E = never, R = never>(
      pathname: BlobPathname,
      source: BlobBody<E, R> | URL,
      options: PutImageOptions,
    ) => Effect.Effect<PutBlobResult, BlobWriteError | E, R>;

    /** Read a blob's metadata without its content. */
    readonly head: (
      blob: BlobLocator,
    ) => Effect.Effect<BlobMetadata, BlobRequestError | BlobNotFound>;

    /**
     * Read a blob's content from its store's host. A pathname is resolved against the configured
     * store; a URL must point at a Blob store (or the configured API origin, for emulators).
     */
    readonly get: (
      blob: BlobLocator,
      options: GetOptions,
    ) => Effect.Effect<GetBlobResult, BlobRequestError | BlobNotFound>;

    /** Read one page of blobs. */
    readonly list: (
      options?: ListOptions & { readonly cursor?: string | undefined },
    ) => Effect.Effect<ListPage, BlobRequestError>;

    /** Every blob matching `options`, fetching pages as the stream is read. */
    readonly listAll: (options?: ListOptions) => Stream.Stream<ListedBlob, BlobRequestError>;

    /**
     * Delete a blob. Deleting a missing blob succeeds; with `ifMatch`, a different ETag fails with
     * `BlobPreconditionFailed`. CDN caches may serve the blob for up to a minute afterwards.
     */
    readonly del: (
      blob: BlobLocator,
      options?: { readonly ifMatch?: ETag | undefined },
    ) => Effect.Effect<void, BlobRequestError | BlobPreconditionFailed>;

    /** Delete several blobs in one request; each counts as one operation for rate limits. */
    readonly delMany: (
      blobs: Array.NonEmptyReadonlyArray<BlobLocator>,
    ) => Effect.Effect<void, BlobRequestError>;

    /**
     * Copy a blob to `to`. The copy does not inherit the source's media type or cache lifetime;
     * pass them again. `ifMatch` is checked against the source.
     */
    readonly copy: (
      from: BlobLocator,
      to: BlobPathname,
      options: CreateBlobOptions,
    ) => Effect.Effect<PutBlobResult, BlobWriteError | BlobNotFound>;

    /**
     * Move a blob to `to`: copied, then the source deleted. If the delete fails the blob exists at
     * both pathnames; retry with `allowOverwrite: true`.
     */
    readonly rename: (
      from: BlobLocator,
      to: BlobPathname,
      options: CreateBlobOptions,
    ) => Effect.Effect<PutBlobResult, BlobWriteError | BlobNotFound>;

    /** Create an empty folder marker; a trailing `/` is added when missing. */
    readonly createFolder: (
      pathname: BlobPathname,
      options?: { readonly access?: BlobAccess | undefined },
    ) => Effect.Effect<CreateFolderResult, BlobWriteError>;

    /**
     * Start a multipart upload to control part sizes and concurrency yourself. Parts must be at
     * least 5 MB except the last, and should all have the same size. `addRandomSuffix` defaults
     * to true here.
     */
    readonly createMultipartUpload: (
      pathname: BlobPathname,
      options: CreateMultipartUploadOptions,
    ) => Effect.Effect<MultipartUpload, BlobWriteError>;

    /** Upload one part of a multipart upload. */
    readonly uploadPart: <E = never, R = never>(
      upload: MultipartUpload,
      partNumber: PartNumber,
      body: BlobBody<E, R>,
    ) => Effect.Effect<UploadedPart, BlobWriteError | E, R>;

    /** Assemble the uploaded parts into the blob. */
    readonly completeMultipartUpload: (
      upload: MultipartUpload,
      parts: Array.NonEmptyReadonlyArray<UploadedPart>,
    ) => Effect.Effect<PutBlobResult, BlobWriteError>;
  }
>()("@effect-vercel/blob/BlobStore") {}
