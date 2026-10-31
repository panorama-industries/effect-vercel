import type { OidcTokenUnavailable } from "@panorama-industries/effect-vercel-core";

import {
  ApiNetworkFailure,
  VercelApiError,
  VercelOidc,
  vercelApiErrorFromStatus,
} from "@panorama-industries/effect-vercel-core";
import { Clock, DateTime, Effect, Layer, Option, Stream } from "effect";
import { Headers, HttpClient } from "effect/http";

import type {
  BlobAccess,
  BlobBody,
  BlobLocator,
  BlobPathname,
  CreateBlobOptions,
  ETag,
  MultipartUpload,
  PartNumber,
  StoreId,
  UploadedPart,
} from "../contracts/blob-domain.ts";
import type {
  BlobWriteError,
  CreateMultipartUploadOptions,
  GetOptions,
  ImageFormat,
  ImageOptimization,
  ListOptions,
  PutImageOptions,
  PutOptions,
} from "../contracts/blob-store.ts";
import type { BlobRequester } from "../internal/blob-request.ts";

import { BlobConfig } from "../contracts/blob-config.ts";
import { FetchedBlob, GetBlobResult, PutBlobResult } from "../contracts/blob-domain.ts";
import {
  BlobNotFound,
  BlobUploadRejected,
  ContentTypeNotAllowed,
} from "../contracts/blob-errors.ts";
import { BlobStore } from "../contracts/blob-store.ts";
import {
  BlobRequestAuth,
  blobRequester,
  blobRequestSettings,
  serverBlobAuth,
} from "../internal/blob-request.ts";
import * as Multipart from "../internal/multipart.ts";
import { blobUrl, downloadUrl, isAllowedBlobUrl, isUrl } from "../internal/urls.ts";
import {
  CreateFolderResponse,
  HeadBlobResponse,
  ListResponse,
  PutBlobResponse,
} from "../internal/wire.ts";
import { allowedWriteOptions, copyWriteHeaders, writeHeaders } from "../internal/write-headers.ts";

/*
 * Domain errors each operation reports, matching the error unions of its contract. Every other
 * domain code an error body carries is reported as `VercelApiError` for its status.
 */
const requestErrors = ["BlobStoreUnavailable", "BlobOidcEnvironmentNotAllowed"] as const;
const readErrors = [...requestErrors, "BlobNotFound"] as const;
const deleteErrors = [...requestErrors, "BlobPreconditionFailed"] as const;
const writeErrors = [...requestErrors, "BlobPreconditionFailed", "BlobUploadRejected"] as const;
const copyErrors = [...writeErrors, "BlobNotFound"] as const;

/** `put` progress events are throttled like the SDK's `throttle(onUploadProgress, 100)`. */
const putProgressInterval = "100 millis";

/** The SDK's `optimizeImageFormatToMimeType`: `format` is sent as the output mime type. */
const imageFormatMimeType: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

const defaultImageQuality = 75;

/** The SDK's `addOptimizeImageParams`; the branded option types already hold its validation. */
const addImageParams = (params: URLSearchParams, optimization: ImageOptimization): void => {
  params.set("width", String(optimization.width));
  params.set("quality", String(optimization.quality ?? defaultImageQuality));
  if (optimization.format !== undefined) {
    params.set("format", imageFormatMimeType[optimization.format]);
  }
};

const isBlob = (body: unknown): body is globalThis.Blob =>
  typeof globalThis.Blob !== "undefined" && body instanceof globalThis.Blob;

/**
 * The SDK's `validateOptimizeImageSourceContentType`: a known media type that is neither an image
 * nor `application/octet-stream` cannot be optimized. Unknown types are left to the server.
 */
const nonImageMediaType = (mediaType: string): boolean =>
  mediaType !== "" && mediaType !== "application/octet-stream" && !mediaType.startsWith("image/");

const locatorString = (locator: BlobLocator): string =>
  typeof locator === "string" ? locator : locator.href;

/** A defect carrying the SDK's `BlobError` message, for input the SDK rejects by throwing. */
const invalidInput = (message: string) => Effect.die(new Error(`Vercel Blob: ${message}`));

const notBlobStoreUrl =
  "Invalid URL: the URL does not point to a Vercel Blob store. Use a pathname instead, see https://vercel.com/docs/vercel-blob";

const header = (headers: Headers.Headers, name: string): string | undefined =>
  Option.getOrUndefined(Headers.get(headers, name));

/**
 * Multipart operations of {@link BlobStoreLive}, over the shared engine in `internal/multipart.ts`
 * with the server's write headers and domain errors.
 */
interface MultipartOperations {
  /** `put(..., { multipart: true })`: automatic multipart over the body stream. */
  readonly put: <E, R>(
    pathname: BlobPathname,
    body: BlobBody<E, R>,
    options: PutOptions,
  ) => Effect.Effect<PutBlobResult, BlobWriteError | E, R>;
  readonly createMultipartUpload: BlobStore["Service"]["createMultipartUpload"];
  readonly uploadPart: BlobStore["Service"]["uploadPart"];
  readonly completeMultipartUpload: BlobStore["Service"]["completeMultipartUpload"];
}

const multipartOperations = (dependencies: {
  readonly requester: BlobRequester;
  readonly auth: Effect.Effect<BlobRequestAuth, OidcTokenUnavailable>;
}): MultipartOperations => {
  const target: Multipart.MultipartTarget<
    OidcTokenUnavailable,
    never,
    (typeof writeErrors)[number]
  > = {
    requester: dependencies.requester,
    auth: dependencies.auth,
    service: "BlobStore",
    domainErrors: writeErrors,
    writeOptions: Multipart.serverMultipartWriteOptions,
  };
  return {
    put: (pathname, body, options) => Multipart.multipartPut(target, pathname, body, options),
    createMultipartUpload: Effect.fn("BlobStore.createMultipartUpload")(function* (
      pathname: BlobPathname,
      options: CreateMultipartUploadOptions,
    ) {
      return yield* Multipart.createMultipartUpload(target, pathname, options);
    }),
    uploadPart: Effect.fn("BlobStore.uploadPart")(function* <E = never, R = never>(
      upload: MultipartUpload,
      partNumber: PartNumber,
      body: BlobBody<E, R>,
    ): Effect.fn.Return<UploadedPart, BlobWriteError | E, R> {
      return yield* Multipart.uploadPart(target, upload, partNumber, body);
    }),
    completeMultipartUpload: Effect.fn("BlobStore.completeMultipartUpload")(function* (
      upload: MultipartUpload,
      parts: ReadonlyArray<UploadedPart>,
    ) {
      return yield* Multipart.completeMultipartUpload(target, upload, parts);
    }),
  };
};

/**
 * Implements {@link BlobStore} over the Blob API with the SDK's wire protocol, retries and error
 * mapping. Requires `BlobConfig`, an `HttpClient`, and `VercelOidc` (evaluated per request when
 * `BlobConfig.auth` is OIDC).
 *
 * `get` reads from the blob's host. A URL locator must pass the SDK's `isAllowedBlobUrl` check (a
 * `*.blob.vercel-storage.com` host, or the origin of an overridden API URL); any other URL, or a
 * string that starts with `http(s)://` but does not parse, is a defect, as are an empty `get`
 * locator and a `putImage` source `URL` that is not http(s). These are programming errors the SDK
 * throws `BlobError` for.
 */
export const BlobStoreLive: Layer.Layer<
  BlobStore,
  never,
  BlobConfig | HttpClient.HttpClient | VercelOidc
> = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const config = yield* BlobConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const oidc = yield* VercelOidc;
    const requester = blobRequester(blobRequestSettings(config, httpClient));
    const auth = serverBlobAuth(config, oidc);
    const multipart = multipartOperations({ requester, auth });

    const put = Effect.fn("BlobStore.put")(function* <E = never, R = never>(
      pathname: BlobPathname,
      body: BlobBody<E, R>,
      options: PutOptions,
    ): Effect.fn.Return<PutBlobResult, BlobWriteError | E, R> {
      if (options.multipart === true) {
        return yield* multipart.put(pathname, body, options);
      }
      const query = new URLSearchParams({ pathname });
      return yield* requester.call({
        operation: "BlobStore.put",
        method: "PUT",
        path: `/?${query.toString()}`,
        auth,
        response: PutBlobResponse,
        headers: writeHeaders(allowedWriteOptions.put, options),
        body,
        locator: pathname,
        domainErrors: writeErrors,
        onUploadProgress: options.onUploadProgress,
        progressInterval: putProgressInterval,
      });
    });

    const putImage = Effect.fn("BlobStore.putImage")(function* <E = never, R = never>(
      pathname: BlobPathname,
      source: BlobBody<E, R> | URL,
      options: PutImageOptions,
    ): Effect.fn.Return<PutBlobResult, BlobWriteError | E, R> {
      const headers = writeHeaders(allowedWriteOptions.putImage, options);
      if (source instanceof URL) {
        if (source.protocol !== "http:" && source.protocol !== "https:") {
          return yield* invalidInput("the source URL must use the http(s) protocol");
        }
        const query = new URLSearchParams({ pathname, url: source.toString() });
        addImageParams(query, options.optimizeImage);
        return yield* requester.call({
          operation: "BlobStore.putImage",
          method: "POST",
          path: `/put-from-url?${query.toString()}`,
          auth,
          response: PutBlobResponse,
          headers,
          locator: pathname,
          domainErrors: writeErrors,
          onUploadProgress: options.onUploadProgress,
        });
      }
      if (isBlob(source) && nonImageMediaType(source.type)) {
        return yield* new BlobUploadRejected({
          reason: new ContentTypeNotAllowed({
            message: `optimizeImage requires an image body, but the content type is "${source.type}"`,
          }),
        });
      }
      const query = new URLSearchParams({ pathname });
      addImageParams(query, options.optimizeImage);
      return yield* requester.call({
        operation: "BlobStore.putImage",
        method: "POST",
        path: `/put-optimized?${query.toString()}`,
        auth,
        response: PutBlobResponse,
        headers,
        body: source,
        locator: pathname,
        domainErrors: writeErrors,
        onUploadProgress: options.onUploadProgress,
      });
    });

    const head = Effect.fn("BlobStore.head")(function* (blob: BlobLocator) {
      const locator = locatorString(blob);
      const query = new URLSearchParams({ url: locator });
      return yield* requester.call({
        operation: "BlobStore.head",
        method: "GET",
        path: `?${query.toString()}`,
        auth,
        response: HeadBlobResponse,
        locator,
        domainErrors: readErrors,
      });
    });

    /** Where `get` reads a locator, and the pathname it reports, as the SDK resolves them. */
    const resolveBlobUrl = (
      blob: BlobLocator,
      storeId: StoreId,
      access: BlobAccess,
    ): Effect.Effect<{ readonly url: URL; readonly pathname: string }> => {
      if (typeof blob === "string" && !isUrl(blob)) {
        return Effect.succeed({
          url: blobUrl(config.blobBaseUrl(storeId, access), blob),
          pathname: blob,
        });
      }
      return Effect.suspend(() => {
        let url: URL;
        try {
          url = typeof blob === "string" ? new URL(blob) : new URL(blob.href);
        } catch {
          return invalidInput("Invalid URL: unable to parse the provided URL");
        }
        if (!isAllowedBlobUrl(url, config.apiUrl)) {
          return invalidInput(notBlobStoreUrl);
        }
        return Effect.succeed({ url, pathname: url.pathname.slice(1) });
      });
    };

    const get = Effect.fn("BlobStore.get")(function* (blob: BlobLocator, options: GetOptions) {
      const operation = "BlobStore.get";
      const locator = locatorString(blob);
      if (locator === "") {
        return yield* invalidInput("url or pathname is required");
      }
      const requestAuth = yield* auth;
      if (!BlobRequestAuth.$is("Bearer")(requestAuth)) {
        return yield* invalidInput("Presigned URLs are not supported for the get method");
      }
      // Server auth only carries store ids from `BlobConfig` or a read-write token: both StoreIds.
      const storeId = requestAuth.storeId as StoreId;
      const { url, pathname } = yield* resolveBlobUrl(blob, storeId, options.access);

      // `useCache: false` bypasses the CDN; the store supports it for private blobs only.
      const fetchUrl = new URL(url.href);
      if (options.useCache === false && options.access === "private") {
        fetchUrl.searchParams.set("cache", "0");
      }

      const response = yield* requester.fetch({
        operation,
        url: fetchUrl,
        token: requestAuth.token,
        headers: {
          ...(options.ifNoneMatch ? { "if-none-match": options.ifNoneMatch } : {}),
          ...options.headers,
        },
      });
      const headers = response.headers;

      if (response.status === 404) {
        yield* Effect.ignore(response.arrayBuffer);
        return yield* new BlobNotFound({ locator });
      }
      if (response.status !== 304 && (response.status < 200 || response.status >= 300)) {
        yield* Effect.ignore(response.arrayBuffer);
        const now = yield* Clock.currentTimeMillis;
        return yield* vercelApiErrorFromStatus(
          {
            operation,
            status: response.status,
            message: `Failed to fetch blob: ${response.status}`,
            errorCode: Option.none(),
            headers,
          },
          now,
        );
      }

      const lastModified = Option.flatMap(
        Option.fromUndefinedOr(header(headers, "last-modified")),
        (value) => DateTime.make(value),
      );
      const uploadedAt = Option.isSome(lastModified) ? lastModified.value : yield* DateTime.now;
      const fetched = new FetchedBlob({
        url,
        downloadUrl: downloadUrl(url),
        pathname,
        contentDisposition: header(headers, "content-disposition") || "",
        cacheControl: header(headers, "cache-control") || "",
        uploadedAt,
        etag: header(headers, "etag") || "",
      });

      if (response.status === 304) {
        return GetBlobResult.NotModified({ blob: fetched, headers });
      }
      const contentLength = header(headers, "content-length");
      return GetBlobResult.Found({
        blob: fetched,
        contentType: header(headers, "content-type") || "application/octet-stream",
        size: contentLength ? Number.parseInt(contentLength, 10) : 0,
        headers,
        body: response.stream.pipe(
          Stream.mapError(
            (error) =>
              new VercelApiError({
                operation,
                errorCode: Option.none(),
                reason: new ApiNetworkFailure({ message: error.message, cause: error }),
              }),
          ),
        ),
      });
    });

    const list = Effect.fn("BlobStore.list")(function* (
      options: ListOptions & { readonly cursor?: string | undefined } = {},
    ) {
      const query = new URLSearchParams();
      if (options.limit) query.set("limit", options.limit.toString());
      if (options.prefix) query.set("prefix", options.prefix);
      if (options.cursor) query.set("cursor", options.cursor);
      if (options.mode) query.set("mode", options.mode);
      return yield* requester.call({
        operation: "BlobStore.list",
        method: "GET",
        // An empty query is omitted: the SDK's undici drops a bare `?`, other fetches send it.
        path: query.size === 0 ? "" : `?${query.toString()}`,
        auth,
        response: ListResponse,
        domainErrors: requestErrors,
      });
    });

    const listAll = (options: ListOptions = {}) =>
      Stream.paginate(undefined as string | undefined, (cursor) =>
        Effect.map(list({ ...options, cursor }), (page) => {
          const next = page.hasMore ? page.cursor : Option.none();
          return [page.blobs, next] as const;
        }),
      );

    const deleteUrls = (
      operation: string,
      urls: ReadonlyArray<string>,
      ifMatch: ETag | undefined,
    ) =>
      requester.call({
        operation,
        method: "POST",
        path: "/delete",
        auth,
        json: { urls },
        headers: ifMatch ? { "x-if-match": ifMatch } : undefined,
        domainErrors: deleteErrors,
      });

    const del = Effect.fn("BlobStore.del")(function* (
      blob: BlobLocator,
      options?: { readonly ifMatch?: ETag | undefined },
    ) {
      return yield* deleteUrls("BlobStore.del", [locatorString(blob)], options?.ifMatch);
    });

    const delMany = Effect.fn("BlobStore.delMany")(function* (blobs: ReadonlyArray<BlobLocator>) {
      return yield* requester.call({
        operation: "BlobStore.delMany",
        method: "POST",
        path: "/delete",
        auth,
        json: { urls: blobs.map(locatorString) },
        domainErrors: requestErrors,
      });
    });

    const copy = Effect.fn("BlobStore.copy")(function* (
      from: BlobLocator,
      to: BlobPathname,
      options: CreateBlobOptions,
    ) {
      const fromUrl = locatorString(from);
      const query = new URLSearchParams({ pathname: to, fromUrl });
      return yield* requester.call({
        operation: "BlobStore.copy",
        method: "PUT",
        path: `?${query.toString()}`,
        auth,
        response: PutBlobResponse,
        headers: copyWriteHeaders(options),
        locator: fromUrl,
        domainErrors: copyErrors,
      });
    });

    const rename = Effect.fn("BlobStore.rename")(function* (
      from: BlobLocator,
      to: BlobPathname,
      options: CreateBlobOptions,
    ) {
      const fromUrl = locatorString(from);
      const query = new URLSearchParams({ pathname: to, fromUrl });
      return yield* requester.call({
        operation: "BlobStore.rename",
        method: "POST",
        path: `/rename?${query.toString()}`,
        auth,
        response: PutBlobResponse,
        headers: copyWriteHeaders(options),
        locator: fromUrl,
        domainErrors: copyErrors,
      });
    });

    const createFolder = Effect.fn("BlobStore.createFolder")(function* (
      pathname: BlobPathname,
      options?: { readonly access?: BlobAccess | undefined },
    ) {
      const folder = pathname.endsWith("/") ? pathname : `${pathname}/`;
      const query = new URLSearchParams({ pathname: folder });
      return yield* requester.call({
        operation: "BlobStore.createFolder",
        method: "PUT",
        path: `/?${query.toString()}`,
        auth,
        response: CreateFolderResponse,
        headers: {
          "x-vercel-blob-access": options?.access ?? "public",
          "x-add-random-suffix": "0",
        },
        locator: folder,
        domainErrors: writeErrors,
      });
    });

    return BlobStore.of({
      put,
      putImage,
      head,
      get,
      list,
      listAll,
      del,
      delMany,
      copy,
      rename,
      createFolder,
      createMultipartUpload: multipart.createMultipartUpload,
      uploadPart: multipart.uploadPart,
      completeMultipartUpload: multipart.completeMultipartUpload,
    });
  }),
);
