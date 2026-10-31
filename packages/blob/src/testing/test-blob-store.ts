import {
  ApiBadRequest,
  ApiUnexpectedResponse,
  VercelApiError,
} from "@panorama-industries/effect-vercel-core";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Random, Stream } from "effect";

import type {
  BlobAccess,
  BlobBody,
  BlobLocator,
  BlobPathname,
  CreateBlobOptions,
  MultipartUpload as MultipartUploadType,
  PartNumber,
} from "../contracts/blob-domain.ts";
import type {
  BlobRequestError,
  BlobWriteError,
  CreateMultipartUploadOptions,
  GetOptions,
  ImageFormat,
  ListOptions,
  PutImageOptions,
  PutOptions,
} from "../contracts/blob-store.ts";

import {
  BlobMetadata,
  CreateFolderResult,
  ETag,
  FetchedBlob,
  GetBlobResult,
  ListedBlob,
  ListPage,
  MultipartUpload,
  PutBlobResult,
  StoreId,
  UploadedPart,
} from "../contracts/blob-domain.ts";
import {
  BlobNotFound,
  BlobPreconditionFailed,
  BlobUploadRejected,
  ContentTypeNotAllowed,
  FileTooLarge,
} from "../contracts/blob-errors.ts";
import { BlobStore } from "../contracts/blob-store.ts";
import { bodyLength, bodyStream } from "../internal/blob-request.ts";
import { blobUrl, defaultBlobBaseUrl, downloadUrl, isUrl } from "../internal/urls.ts";
import { cacheControlMaxAgeSeconds } from "../internal/write-headers.ts";

/** A `BlobStore` operation, as recorded by {@link TestBlobStore}. */
export type TestBlobStoreOperation = keyof TestBlobStoreOperationError;

/** Errors each operation can be scripted to fail with. `listAll` fails through `list`. */
export interface TestBlobStoreOperationError {
  readonly put: BlobWriteError;
  readonly putImage: BlobWriteError;
  readonly head: BlobRequestError | BlobNotFound;
  readonly get: BlobRequestError | BlobNotFound;
  readonly list: BlobRequestError;
  readonly del: BlobRequestError | BlobPreconditionFailed;
  readonly delMany: BlobRequestError;
  readonly copy: BlobWriteError | BlobNotFound;
  readonly rename: BlobWriteError | BlobNotFound;
  readonly createFolder: BlobWriteError;
  readonly createMultipartUpload: BlobWriteError;
  readonly uploadPart: BlobWriteError;
  readonly completeMultipartUpload: BlobWriteError;
}

/** One call made to the test `BlobStore`, in call order. */
export interface TestBlobStoreCall {
  readonly operation: TestBlobStoreOperation;
  /** When the call was made, in epoch milliseconds. */
  readonly at: number;
  /** The pathname written: the requested one, before any random suffix. */
  readonly pathname?: string;
  /** The blobs read, deleted, copied or renamed, as given. */
  readonly locators?: ReadonlyArray<string>;
  readonly partNumber?: number;
  readonly prefix?: string;
  readonly cursor?: string;
}

/** A blob held by the in-memory store, with everything the store reports about it. */
export interface TestBlob {
  /** Final pathname, including any random suffix. */
  readonly pathname: string;
  readonly access: BlobAccess;
  readonly url: URL;
  readonly downloadUrl: URL;
  readonly size: number;
  readonly uploadedAt: DateTime.Utc;
  readonly contentType: string;
  readonly contentDisposition: string;
  /** The `Cache-Control` value served, such as `public, max-age=2592000`. */
  readonly cacheControl: string;
  /** Cache lifetime in seconds. */
  readonly cacheControlMaxAge: number;
  readonly etag: ETag;
  /** A copy of the content. */
  readonly body: Uint8Array;
}

/** How {@link TestBlobStore} `seed` stores a blob. */
export interface TestBlobSeedOptions {
  /** The store's access by default. */
  readonly access?: BlobAccess | undefined;

  /** Inferred from the pathname extension by default, like a write. */
  readonly contentType?: string | undefined;

  /** One month by default. */
  readonly cacheControlMaxAge?: Duration.Input | undefined;
}

/** Options of {@link TestBlobStore.layerWith}. */
export interface TestBlobStoreOptions {
  /** Store id used in blob URLs; `teststore` by default. */
  readonly storeId?: StoreId | undefined;

  /**
   * The access every blob of the store has, `public` by default. Like a real store, writes with
   * the other access fail.
   */
  readonly access?: BlobAccess | undefined;
}

interface StoredBlob {
  readonly pathname: string;
  readonly access: BlobAccess;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly cacheControlMaxAge: number;
  readonly etag: ETag;
  readonly uploadedAt: DateTime.Utc;
}

interface PendingUpload {
  readonly key: string;
  /** Checked again at completion, since parts and completion do not resend it. */
  readonly ifMatch: string | undefined;
  readonly parts: Map<number, { readonly etag: string; readonly bytes: Uint8Array }>;
}

interface RemoteSource {
  readonly body: Uint8Array;
  readonly contentType: Option.Option<string>;
}

/** What a write stores, before the pathname gets its suffix. */
interface WriteInput {
  readonly operation: string;
  readonly pathname: string;
  readonly addRandomSuffix: boolean;
  readonly access: BlobAccess;
  readonly body: Uint8Array;
  readonly contentType: string | undefined;
  /** The request's `Content-Type`, used when the pathname has no known extension. */
  readonly requestContentType: string;
  readonly cacheControlMaxAge: number | undefined;
  readonly allowOverwrite: boolean;
  /** Condition on the blob being replaced; `copy` and `rename` check the source instead. */
  readonly ifMatch: string | undefined;
}

const defaultStoreId = StoreId.make("teststore");

/** The store's default cache lifetime: one month (30 days), in seconds. */
const oneMonthSeconds = 30 * 24 * 60 * 60;

const defaultListLimit = 1000;

const suffixLength = 30;
const suffixAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const textEncoder = new TextEncoder();

/**
 * Media types the store infers from a pathname extension. The store knows many more; a pathname
 * without one of these falls back to the request's `Content-Type`.
 */
const extensionMediaTypes: Readonly<Record<string, string>> = {
  aac: "audio/x-aac",
  avif: "image/avif",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html",
  html: "text/html",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  heic: "image/heic",
  js: "application/javascript",
  json: "application/json",
  m4a: "audio/mp4",
  md: "text/markdown",
  mjs: "application/javascript",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  ogv: "video/ogg",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  tif: "image/tiff",
  tiff: "image/tiff",
  ttf: "font/ttf",
  txt: "text/plain",
  wasm: "application/wasm",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  zip: "application/zip",
};

const imageFormatMediaType: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

const lastSegment = (pathname: string): string => pathname.slice(pathname.lastIndexOf("/") + 1);

/** Index of the extension's dot in the last segment, or -1; a leading dot is not an extension. */
const extensionDot = (pathname: string): number => {
  const segmentStart = pathname.lastIndexOf("/") + 1;
  const dot = pathname.lastIndexOf(".");
  return dot > segmentStart ? dot : -1;
};

const extensionMediaType = (pathname: string): string | undefined => {
  const dot = extensionDot(pathname);
  return dot === -1 ? undefined : extensionMediaTypes[pathname.slice(dot + 1).toLowerCase()];
};

const octetStream = "application/octet-stream";

/** The `Content-Type` `fetch` sends for a body: strings are text, typed `Blob`s keep their type. */
const requestContentTypeOf = (body: unknown): string =>
  typeof body === "string"
    ? "text/plain;charset=UTF-8"
    : isBlob(body) && body.type !== ""
      ? body.type
      : octetStream;

/**
 * Media types the store serves `inline`, compared exactly as stored: `text/plain` is inline but
 * `text/plain; charset=utf-8` is not. Any `image/`, `audio/` or `video/` type is inline too.
 */
const inlineMediaTypes: ReadonlySet<string> = new Set([
  "application/json",
  "application/pdf",
  "text/plain",
  "text/xml",
]);

const isInline = (contentType: string): boolean =>
  inlineMediaTypes.has(contentType) || /^(image|audio|video)\//.test(contentType);

const contentDispositionOf = (contentType: string, pathname: string): string =>
  `${isInline(contentType) ? "inline" : "attachment"}; filename="${encodeURIComponent(lastSegment(pathname))}"`;

/** The store serves every blob as `public` for caches, private ones included. */
const cacheControlOf = (seconds: number): string => `public, max-age=${seconds}`;

/** ETags compare without their quotes or weak marker, as `If-Match` values are often sent bare. */
const sameEtag = (a: string, b: string): boolean => {
  const bare = (etag: string) => etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  return bare(a) === bare(b);
};

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/** Read a body completely; a stream's failures and requirements become the caller's. */
const readBody = <E, R>(body: BlobBody<E, R>): Effect.Effect<Uint8Array, E, R> =>
  Effect.map(Stream.runCollect(bodyStream(body)), concatBytes);

const toBytes = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? textEncoder.encode(body) : body.slice();

const isBlob = (body: unknown): body is globalThis.Blob =>
  typeof globalThis.Blob !== "undefined" && body instanceof globalThis.Blob;

const locatorString = (locator: BlobLocator): string =>
  typeof locator === "string" ? locator : locator.href;

const badRequest = (operation: string, message: string) =>
  new VercelApiError({
    operation,
    errorCode: Option.some("bad_request"),
    reason: new ApiBadRequest({ message }),
  });

/** The store's answer to a write over an existing blob without `allowOverwrite`. */
const blobAlreadyExistsMessage =
  "This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename. Read more about this error in our documentation: https://vercel.link/blob-allow-overwrite";

/** The store's answer to a write whose access differs from the store's. */
const wrongAccessMessage = (store: BlobAccess): string =>
  store === "private"
    ? "Cannot use public access on a private store. The store is configured with private access."
    : "Cannot use private access on a public store. The store must be configured with private access.";

const uploadNotFound = (operation: string) =>
  new VercelApiError({
    operation,
    errorCode: Option.some("not_found"),
    reason: new ApiUnexpectedResponse({
      message: "The multipart upload does not exist",
      status: 404,
    }),
  });

/** A defect carrying the SDK's `BlobError` message, as `BlobStoreLive` raises for invalid input. */
const invalidInput = (message: string) => Effect.die(new Error(`Vercel Blob: ${message}`));

const notBlobStoreUrl =
  "Invalid URL: the URL does not point to a Vercel Blob store. Use a pathname instead, see https://vercel.com/docs/vercel-blob";

/**
 * Inspects and scripts the in-memory store behind {@link TestBlobStore.layer}.
 *
 * Time follows `Clock` and random suffixes follow `Random`, so `TestClock` and `Random.withSeed`
 * make results deterministic.
 */
export class TestBlobStore extends Context.Service<
  TestBlobStore,
  {
    /** Every `BlobStore` call so far, in order, including calls that failed. */
    readonly calls: Effect.Effect<ReadonlyArray<TestBlobStoreCall>>;

    /** Every stored blob, in pathname order. */
    readonly blobs: Effect.Effect<ReadonlyArray<TestBlob>>;

    /** The blob at a final pathname (including any random suffix). */
    readonly blob: (pathname: string) => Effect.Effect<Option.Option<TestBlob>>;

    /**
     * Store a blob directly, replacing any blob at `pathname`, without recording a call or
     * consuming a scripted failure.
     */
    readonly seed: (
      pathname: string,
      body: string | Uint8Array,
      options?: TestBlobSeedOptions,
    ) => Effect.Effect<TestBlob>;

    /** Make the next call to `operation` fail with `error` instead of running. */
    readonly failNext: <Op extends TestBlobStoreOperation>(
      operation: Op,
      error: TestBlobStoreOperationError[Op],
    ) => Effect.Effect<void>;

    /**
     * Content the store fetches for a `putImage` source URL outside the store. Blob URLs of this
     * store resolve to the stored blob; any other unserved URL fails with `ApiBadRequest`.
     */
    readonly serveUrl: (
      url: string | URL,
      body: string | Uint8Array,
      contentType?: string,
    ) => Effect.Effect<void>;
  }
>()("@effect-vercel/blob/TestBlobStore") {
  /**
   * An in-memory `BlobStore` with the store's write, read, listing and multipart semantics, plus
   * the {@link TestBlobStore} controls. Each build of the layer holds its own empty store.
   *
   * Behavior checked against real stores by `test/live` (`pnpm test:live`):
   *
   * - The store has one access, `public` unless set with {@link TestBlobStore.layerWith}; writes
   *   with the other access fail with `VercelApiError` / `ApiBadRequest` (`bad_request`).
   * - Writes refuse an existing pathname with `ApiBadRequest` unless `allowOverwrite` is set,
   *   except `copy`, which always replaces. `ifMatch` replaces only a blob with that ETag and
   *   otherwise fails with `BlobPreconditionFailed`, also when nothing is stored there. Copying or
   *   renaming a missing blob fails with `BlobNotFound`.
   * - Every write gets a new ETag and `uploadedAt` from `Clock`. `addRandomSuffix` inserts 30
   *   characters from `Random` before the extension.
   * - Media types come from the option, then common extensions, then the request: text for a
   *   string body, the type of a typed `Blob`, `application/octet-stream` otherwise. Images,
   *   audio, video, `text/plain`, `text/xml`, `application/json` and `application/pdf` are served
   *   `inline`, anything else as `attachment`, with a percent-encoded filename. Cache-Control is
   *   `public, max-age=<seconds>` for every blob, one month by default.
   * - URLs are `https://<storeId>.<access>.blob.vercel-storage.com/<pathname>`. A URL locator
   *   addresses a blob only with this store's host and the blob's access; `get` with a pathname
   *   finds it only under the given `access`.
   * - `list` orders by pathname, with opaque cursors. `putImage` stores the source unchanged.
   *   Multipart uploads assemble their parts in part-number order; part sizes are not checked.
   * - Progress reports 0 % before the body is read and 100 % once stored.
   */
  static readonly layer: Layer.Layer<BlobStore | TestBlobStore> = TestBlobStore.layerWith({});

  /** {@link TestBlobStore.layer} with a chosen store id or access. */
  static layerWith(options: TestBlobStoreOptions): Layer.Layer<BlobStore | TestBlobStore> {
    return Layer.effectContext(Effect.sync(() => buildTestBlobStore(options)));
  }
}

function buildTestBlobStore(
  options: TestBlobStoreOptions,
): Context.Context<BlobStore | TestBlobStore> {
  const storeId = options.storeId ?? defaultStoreId;
  const storeAccess = options.access ?? "public";
  const storeHost = (access: BlobAccess) => defaultBlobBaseUrl(storeId, access).hostname;
  const stored = new Map<string, StoredBlob>();
  const uploads = new Map<string, PendingUpload>();
  const remotes = new Map<string, RemoteSource>();
  const recorded: Array<TestBlobStoreCall> = [];
  const scripted = new Map<TestBlobStoreOperation, Array<unknown>>();
  let sequence = 0;

  const nextEtag = () => ETag.make(`"etag-${++sequence}"`);
  const urlOf = (pathname: string, access: BlobAccess) =>
    blobUrl(defaultBlobBaseUrl(storeId, access), pathname);

  const view = (blob: StoredBlob): TestBlob => {
    const url = urlOf(blob.pathname, blob.access);
    return {
      pathname: blob.pathname,
      access: blob.access,
      url,
      downloadUrl: downloadUrl(url),
      size: blob.body.length,
      uploadedAt: blob.uploadedAt,
      contentType: blob.contentType,
      contentDisposition: contentDispositionOf(blob.contentType, blob.pathname),
      cacheControl: cacheControlOf(blob.cacheControlMaxAge),
      cacheControlMaxAge: blob.cacheControlMaxAge,
      etag: blob.etag,
      body: blob.body.slice(),
    };
  };

  const putResult = (blob: StoredBlob) => {
    const { url, downloadUrl, pathname, contentType, contentDisposition, etag } = view(blob);
    return new PutBlobResult({ url, downloadUrl, pathname, contentType, contentDisposition, etag });
  };

  const call = <Op extends TestBlobStoreOperation, A, E, R>(
    entry: Omit<TestBlobStoreCall, "at"> & { readonly operation: Op },
    run: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | TestBlobStoreOperationError[Op], R> =>
    Effect.flatMap(
      Clock.currentTimeMillis,
      (now): Effect.Effect<A, E | TestBlobStoreOperationError[Op], R> => {
        recorded.push({ ...entry, at: now });
        const failure = scripted.get(entry.operation)?.shift();
        if (failure !== undefined) {
          return Effect.fail(failure as TestBlobStoreOperationError[Op]);
        }
        return run;
      },
    );

  const suffixed = Effect.fnUntraced(function* (pathname: string) {
    let suffix = "";
    for (let index = 0; index < suffixLength; index++) {
      suffix += suffixAlphabet[yield* Random.nextIntBetween(0, suffixAlphabet.length - 1)];
    }
    const dot = extensionDot(pathname);
    return dot === -1
      ? `${pathname}-${suffix}`
      : `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
  });

  /** Whether a write with `access` may replace what is stored at `pathname` now. */
  const checkWrite = (
    operation: string,
    pathname: string,
    access: BlobAccess,
    allowOverwrite: boolean,
    ifMatch: string | undefined,
  ): Effect.Effect<void, VercelApiError | BlobPreconditionFailed> => {
    if (access !== storeAccess) {
      return Effect.fail(badRequest(operation, wrongAccessMessage(storeAccess)));
    }
    const existing = stored.get(pathname);
    if (ifMatch !== undefined) {
      return existing !== undefined && sameEtag(existing.etag, ifMatch)
        ? Effect.void
        : Effect.fail(new BlobPreconditionFailed());
    }
    return existing !== undefined && !allowOverwrite
      ? Effect.fail(badRequest(operation, blobAlreadyExistsMessage))
      : Effect.void;
  };

  /** Check and store in one step, so concurrent writes cannot interleave between the two. */
  const commit = (
    input: Omit<WriteInput, "addRandomSuffix">,
    uploadedAt: DateTime.Utc,
  ): Effect.Effect<StoredBlob, VercelApiError | BlobPreconditionFailed> =>
    Effect.suspend(() =>
      Effect.map(
        checkWrite(
          input.operation,
          input.pathname,
          input.access,
          input.allowOverwrite,
          input.ifMatch,
        ),
        () => {
          const blob: StoredBlob = {
            pathname: input.pathname,
            access: input.access,
            body: input.body,
            contentType:
              input.contentType || (extensionMediaType(input.pathname) ?? input.requestContentType),
            cacheControlMaxAge: input.cacheControlMaxAge ?? oneMonthSeconds,
            etag: nextEtag(),
            uploadedAt,
          };
          stored.set(blob.pathname, blob);
          return blob;
        },
      ),
    );

  const write = Effect.fnUntraced(function* (input: WriteInput) {
    const pathname = input.addRandomSuffix ? yield* suffixed(input.pathname) : input.pathname;
    const uploadedAt = yield* DateTime.now;
    return yield* commit({ ...input, pathname }, uploadedAt);
  });

  const maxAgeSeconds = (maxAge: Duration.Input | undefined) =>
    maxAge === undefined ? undefined : cacheControlMaxAgeSeconds(maxAge);

  /** The pathname a locator names in this store, and the access its URL requires. */
  const locate = (
    locator: BlobLocator,
  ): Option.Option<{ readonly pathname: string; readonly access: Option.Option<BlobAccess> }> => {
    if (typeof locator === "string" && !isUrl(locator)) {
      return Option.some({ pathname: locator, access: Option.none() });
    }
    let url: URL;
    try {
      url = new URL(locatorString(locator));
    } catch {
      return Option.none();
    }
    const access = (["public", "private"] as const).find(
      (candidate) => url.hostname === storeHost(candidate),
    );
    if (access === undefined) return Option.none();
    try {
      return Option.some({
        pathname: decodeURIComponent(url.pathname.slice(1)),
        access: Option.some(access),
      });
    } catch {
      return Option.none();
    }
  };

  const find = (locator: BlobLocator, access?: BlobAccess): Option.Option<StoredBlob> =>
    Option.flatMap(locate(locator), (located) => {
      const blob = stored.get(located.pathname);
      const required = Option.getOrElse(located.access, () => access);
      if (blob === undefined || (required !== undefined && blob.access !== required)) {
        return Option.none();
      }
      return Option.some(blob);
    });

  const progressed = <A extends { readonly body: Uint8Array }, E, R>(
    onUploadProgress: PutOptions["onUploadProgress"],
    total: number,
    run: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    onUploadProgress === undefined
      ? run
      : Effect.gen(function* () {
          yield* onUploadProgress({ loaded: 0, total, percentage: 0 });
          const result = yield* run;
          const loaded = result.body.length;
          yield* onUploadProgress({ loaded, total: loaded, percentage: 100 });
          return result;
        });

  const put = Effect.fn("BlobStore.put")(function* <E = never, R = never>(
    pathname: BlobPathname,
    body: BlobBody<E, R>,
    options: PutOptions,
  ): Effect.fn.Return<PutBlobResult, BlobWriteError | E, R> {
    const operation = "BlobStore.put";
    const total = bodyLength(body);
    const maximum = options.maximumSizeInBytes;
    const run = Effect.gen(function* () {
      if (
        options.multipart === true &&
        maximum !== undefined &&
        !Stream.isStream(body) &&
        total > maximum
      ) {
        return yield* new BlobUploadRejected({
          reason: new FileTooLarge({
            message: `Body size of ${total} bytes exceeds the maximum allowed size of ${maximum} bytes`,
          }),
        });
      }
      return yield* progressed(
        options.onUploadProgress,
        total,
        Effect.flatMap(readBody(body), (bytes) =>
          write({
            operation,
            pathname,
            addRandomSuffix: options.addRandomSuffix ?? false,
            access: options.access,
            body: bytes,
            contentType: options.contentType,
            requestContentType:
              options.multipart === true ? octetStream : requestContentTypeOf(body),
            cacheControlMaxAge: maxAgeSeconds(options.cacheControlMaxAge),
            allowOverwrite: options.allowOverwrite === true || options.ifMatch !== undefined,
            ifMatch: options.ifMatch,
          }),
        ),
      );
    });
    return putResult(yield* call({ operation: "put", pathname }, run));
  });

  const imageSource = <E, R>(
    source: BlobBody<E, R> | URL,
  ): Effect.Effect<RemoteSource, E | VercelApiError, R> => {
    if (!(source instanceof URL)) {
      return Effect.map(readBody(source), (body) => ({
        body,
        contentType:
          isBlob(source) && source.type !== "" ? Option.some(source.type) : Option.none(),
      }));
    }
    const blob = find(source);
    if (Option.isSome(blob)) {
      return Effect.succeed({
        body: blob.value.body,
        contentType: Option.some(blob.value.contentType),
      });
    }
    const remote = remotes.get(source.href);
    return remote === undefined
      ? Effect.fail(badRequest("BlobStore.putImage", `Failed to fetch the image at ${source.href}`))
      : Effect.succeed(remote);
  };

  const putImage = Effect.fn("BlobStore.putImage")(function* <E = never, R = never>(
    pathname: BlobPathname,
    source: BlobBody<E, R> | URL,
    options: PutImageOptions,
  ): Effect.fn.Return<PutBlobResult, BlobWriteError | E, R> {
    if (source instanceof URL && source.protocol !== "http:" && source.protocol !== "https:") {
      return yield* invalidInput("the source URL must use the http(s) protocol");
    }
    const run = Effect.gen(function* () {
      if (
        isBlob(source) &&
        source.type !== "" &&
        source.type !== "application/octet-stream" &&
        !source.type.startsWith("image/")
      ) {
        return yield* new BlobUploadRejected({
          reason: new ContentTypeNotAllowed({
            message: `optimizeImage requires an image body, but the content type is "${source.type}"`,
          }),
        });
      }
      const format = options.optimizeImage.format;
      return yield* progressed(
        options.onUploadProgress,
        source instanceof URL ? 0 : bodyLength(source),
        Effect.flatMap(imageSource(source), (image) =>
          write({
            operation: "BlobStore.putImage",
            pathname,
            addRandomSuffix: options.addRandomSuffix ?? false,
            access: options.access,
            body: image.body,
            contentType:
              format === undefined
                ? Option.getOrUndefined(image.contentType)
                : imageFormatMediaType[format],
            requestContentType: octetStream,
            cacheControlMaxAge: maxAgeSeconds(options.cacheControlMaxAge),
            allowOverwrite: options.allowOverwrite === true || options.ifMatch !== undefined,
            ifMatch: options.ifMatch,
          }),
        ),
      );
    });
    return putResult(yield* call({ operation: "putImage", pathname }, run));
  });

  const head = Effect.fn("BlobStore.head")(function* (blob: BlobLocator) {
    const locator = locatorString(blob);
    const run = Effect.suspend(() =>
      Option.match(find(blob), {
        onNone: () => Effect.fail(new BlobNotFound({ locator })),
        onSome: (found) => {
          const current = view(found);
          return Effect.succeed(
            new BlobMetadata({
              url: current.url,
              downloadUrl: current.downloadUrl,
              pathname: current.pathname,
              size: current.size,
              uploadedAt: current.uploadedAt,
              contentType: current.contentType,
              contentDisposition: current.contentDisposition,
              cacheControl: current.cacheControl,
              etag: current.etag,
            }),
          );
        },
      }),
    );
    return yield* call({ operation: "head", locators: [locator] }, run);
  });

  const get = Effect.fn("BlobStore.get")(function* (blob: BlobLocator, options: GetOptions) {
    const locator = locatorString(blob);
    if (locator === "") {
      return yield* invalidInput("url or pathname is required");
    }
    if (isUrl(locator)) {
      let url: URL | undefined;
      try {
        url = new URL(locator);
      } catch {
        return yield* invalidInput("Invalid URL: unable to parse the provided URL");
      }
      if (!url.hostname.endsWith(".blob.vercel-storage.com")) {
        return yield* invalidInput(notBlobStoreUrl);
      }
    }
    const run = Effect.suspend(() =>
      Option.match(find(blob, options.access), {
        onNone: () => Effect.fail(new BlobNotFound({ locator })),
        onSome: (found): Effect.Effect<GetBlobResult> => {
          const current = view(found);
          const validators: Record<string, string> = {
            "cache-control": current.cacheControl,
            "content-disposition": current.contentDisposition,
            etag: current.etag,
            "last-modified": DateTime.toDateUtc(current.uploadedAt).toUTCString(),
          };
          const fetched = new FetchedBlob({
            url: current.url,
            downloadUrl: current.downloadUrl,
            pathname: current.pathname,
            contentDisposition: current.contentDisposition,
            cacheControl: current.cacheControl,
            uploadedAt: current.uploadedAt,
            etag: current.etag,
          });
          if (options.ifNoneMatch !== undefined && sameEtag(current.etag, options.ifNoneMatch)) {
            return Effect.succeed(
              GetBlobResult.NotModified({ blob: fetched, headers: validators }),
            );
          }
          return Effect.succeed(
            GetBlobResult.Found({
              blob: fetched,
              contentType: current.contentType,
              size: current.size,
              headers: {
                ...validators,
                "content-length": String(current.size),
                "content-type": current.contentType,
              },
              body: Stream.succeed(current.body),
            }),
          );
        },
      }),
    );
    return yield* call({ operation: "get", locators: [locator] }, run);
  });

  type ListArgs = ListOptions & { readonly cursor?: string | undefined };

  /** The page's entries: blobs, and in folded mode the folders directly under the prefix. */
  const listEntries = (args: ListArgs) => {
    const prefix = args.prefix ?? "";
    const folded = args.mode === "folded";
    const entries = new Map<string, Option.Option<StoredBlob>>();
    for (const blob of stored.values()) {
      if (!blob.pathname.startsWith(prefix)) continue;
      const slash = folded ? blob.pathname.indexOf("/", prefix.length) : -1;
      if (slash === -1) {
        entries.set(blob.pathname, Option.some(blob));
      } else {
        entries.set(blob.pathname.slice(0, slash + 1), Option.none());
      }
    }
    return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  };

  const listPage = (args: ListArgs) =>
    Effect.sync(() => {
      const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 1000) : defaultListLimit;
      const after = args.cursor;
      const remaining = listEntries(args).filter(([key]) => after === undefined || key > after);
      const page = remaining.slice(0, limit);
      const hasMore = remaining.length > page.length;
      return new ListPage({
        blobs: page.flatMap(([, entry]) =>
          Option.match(entry, {
            onNone: () => [],
            onSome: (blob) => {
              const { url, downloadUrl, pathname, size, uploadedAt, etag } = view(blob);
              return [new ListedBlob({ url, downloadUrl, pathname, size, uploadedAt, etag })];
            },
          }),
        ),
        folders: page.flatMap(([key, entry]) => (Option.isNone(entry) ? [key] : [])),
        cursor: hasMore ? Option.some(page[page.length - 1]![0]) : Option.none(),
        hasMore,
      });
    });

  const list = Effect.fn("BlobStore.list")(function* (args: ListArgs = {}) {
    return yield* call(
      {
        operation: "list",
        ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      },
      listPage(args),
    );
  });

  const listAll = (args: ListOptions = {}) =>
    Stream.paginate(undefined as string | undefined, (cursor) =>
      Effect.map(list({ ...args, cursor }), (page) => {
        const next = page.hasMore ? page.cursor : Option.none();
        return [page.blobs, next] as const;
      }),
    );

  const del = Effect.fn("BlobStore.del")(function* (
    blob: BlobLocator,
    options?: { readonly ifMatch?: ETag | undefined },
  ) {
    const run = Effect.suspend((): Effect.Effect<void, VercelApiError | BlobPreconditionFailed> => {
      const found = find(blob);
      const ifMatch = options?.ifMatch;
      if (ifMatch !== undefined && (Option.isNone(found) || !sameEtag(found.value.etag, ifMatch))) {
        return Effect.fail(new BlobPreconditionFailed());
      }
      if (Option.isSome(found)) stored.delete(found.value.pathname);
      return Effect.void;
    });
    return yield* call({ operation: "del", locators: [locatorString(blob)] }, run);
  });

  const delMany = Effect.fn("BlobStore.delMany")(function* (blobs: ReadonlyArray<BlobLocator>) {
    const run = Effect.sync(() => {
      for (const blob of blobs) {
        const found = find(blob);
        if (Option.isSome(found)) stored.delete(found.value.pathname);
      }
    });
    return yield* call({ operation: "delMany", locators: blobs.map(locatorString) }, run);
  });

  /** Copy `from` to `to` without inheriting its media type or cache lifetime. */
  const copyBlob = (
    operation: string,
    from: BlobLocator,
    to: string,
    options: CreateBlobOptions,
    allowOverwrite: boolean,
  ) =>
    Effect.gen(function* () {
      const source = find(from);
      if (Option.isNone(source)) {
        return yield* new BlobNotFound({ locator: locatorString(from) });
      }
      if (options.ifMatch !== undefined && !sameEtag(source.value.etag, options.ifMatch)) {
        return yield* new BlobPreconditionFailed();
      }
      const copied = yield* write({
        operation,
        pathname: to,
        addRandomSuffix: options.addRandomSuffix ?? false,
        access: options.access,
        body: source.value.body,
        contentType: options.contentType,
        requestContentType: octetStream,
        cacheControlMaxAge: maxAgeSeconds(options.cacheControlMaxAge),
        allowOverwrite,
        ifMatch: undefined,
      });
      return { source: source.value, copied };
    });

  const copy = Effect.fn("BlobStore.copy")(function* (
    from: BlobLocator,
    to: BlobPathname,
    options: CreateBlobOptions,
  ) {
    // The store replaces an existing blob at `to` whatever `allowOverwrite` says.
    const run = Effect.map(copyBlob("BlobStore.copy", from, to, options, true), ({ copied }) =>
      putResult(copied),
    );
    return yield* call({ operation: "copy", pathname: to, locators: [locatorString(from)] }, run);
  });

  const rename = Effect.fn("BlobStore.rename")(function* (
    from: BlobLocator,
    to: BlobPathname,
    options: CreateBlobOptions,
  ) {
    const run = Effect.map(
      copyBlob("BlobStore.rename", from, to, options, options.allowOverwrite === true),
      ({ source, copied }) => {
        if (source.pathname !== copied.pathname && stored.get(source.pathname) === source) {
          stored.delete(source.pathname);
        }
        return putResult(copied);
      },
    );
    return yield* call({ operation: "rename", pathname: to, locators: [locatorString(from)] }, run);
  });

  const createFolder = Effect.fn("BlobStore.createFolder")(function* (
    pathname: BlobPathname,
    options?: { readonly access?: BlobAccess | undefined },
  ) {
    const folder = pathname.endsWith("/") ? pathname : `${pathname}/`;
    const run = Effect.map(
      write({
        operation: "BlobStore.createFolder",
        pathname: folder,
        addRandomSuffix: false,
        access: options?.access ?? "public",
        body: new Uint8Array(0),
        contentType: undefined,
        requestContentType: octetStream,
        cacheControlMaxAge: undefined,
        allowOverwrite: false,
        ifMatch: undefined,
      }),
      (blob) =>
        new CreateFolderResult({ url: urlOf(blob.pathname, blob.access), pathname: folder }),
    );
    return yield* call({ operation: "createFolder", pathname }, run);
  });

  const createMultipartUpload = Effect.fn("BlobStore.createMultipartUpload")(function* (
    pathname: BlobPathname,
    options: CreateMultipartUploadOptions,
  ) {
    const operation = "BlobStore.createMultipartUpload";
    const run = Effect.gen(function* () {
      const key = (options.addRandomSuffix ?? true) ? yield* suffixed(pathname) : pathname;
      yield* checkWrite(
        operation,
        key,
        options.access,
        options.allowOverwrite === true || options.ifMatch !== undefined,
        options.ifMatch,
      );
      const uploadId = `upload-${++sequence}`;
      uploads.set(uploadId, { key, ifMatch: options.ifMatch, parts: new Map() });
      const maxAge = maxAgeSeconds(options.cacheControlMaxAge);
      return new MultipartUpload({
        pathname,
        key,
        uploadId,
        access: options.access,
        ...(options.addRandomSuffix === undefined
          ? {}
          : { addRandomSuffix: options.addRandomSuffix }),
        ...(options.ifMatch !== undefined
          ? { allowOverwrite: true }
          : options.allowOverwrite === undefined
            ? {}
            : { allowOverwrite: options.allowOverwrite }),
        ...(options.contentType ? { contentType: options.contentType } : {}),
        ...(maxAge === undefined ? {} : { cacheControlMaxAge: maxAge }),
      });
    });
    return yield* call({ operation: "createMultipartUpload", pathname }, run);
  });

  const pendingUpload = (operation: string, upload: MultipartUploadType) =>
    Effect.suspend(() => {
      const pending = uploads.get(upload.uploadId);
      return pending === undefined || pending.key !== upload.key
        ? Effect.fail(uploadNotFound(operation))
        : Effect.succeed(pending);
    });

  const uploadPart = Effect.fn("BlobStore.uploadPart")(function* <E = never, R = never>(
    upload: MultipartUploadType,
    partNumber: PartNumber,
    body: BlobBody<E, R>,
  ): Effect.fn.Return<UploadedPart, BlobWriteError | E, R> {
    const run = Effect.gen(function* () {
      yield* pendingUpload("BlobStore.uploadPart", upload);
      const bytes = yield* readBody(body);
      const pending = yield* pendingUpload("BlobStore.uploadPart", upload);
      const etag = `"part-${++sequence}"`;
      pending.parts.set(partNumber, { etag, bytes });
      return new UploadedPart({ etag, partNumber });
    });
    return yield* call({ operation: "uploadPart", pathname: upload.pathname, partNumber }, run);
  });

  const completeMultipartUpload = Effect.fn("BlobStore.completeMultipartUpload")(function* (
    upload: MultipartUploadType,
    parts: ReadonlyArray<UploadedPart>,
  ) {
    const operation = "BlobStore.completeMultipartUpload";
    const run = Effect.gen(function* () {
      const pending = yield* pendingUpload(operation, upload);
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const chunks: Array<Uint8Array> = [];
      for (const part of ordered) {
        const uploaded = pending.parts.get(part.partNumber);
        if (uploaded === undefined || !sameEtag(uploaded.etag, part.etag)) {
          return yield* badRequest(
            operation,
            "One or more of the specified parts could not be found. The part may not have been uploaded, or the specified ETag may not match the part's ETag.",
          );
        }
        chunks.push(uploaded.bytes);
      }
      const uploadedAt = yield* DateTime.now;
      const blob = yield* commit(
        {
          operation,
          pathname: pending.key,
          access: upload.access,
          body: concatBytes(chunks),
          contentType: upload.contentType,
          requestContentType: octetStream,
          cacheControlMaxAge: upload.cacheControlMaxAge,
          allowOverwrite: upload.allowOverwrite === true || pending.ifMatch !== undefined,
          ifMatch: pending.ifMatch,
        },
        uploadedAt,
      );
      uploads.delete(upload.uploadId);
      return putResult(blob);
    });
    return yield* call({ operation: "completeMultipartUpload", pathname: upload.pathname }, run);
  });

  const api = BlobStore.of({
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
    createMultipartUpload,
    uploadPart,
    completeMultipartUpload,
  });

  const control = TestBlobStore.of({
    calls: Effect.sync(() => [...recorded]),
    blobs: Effect.sync(() =>
      [...stored.values()]
        .sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0))
        .map(view),
    ),
    blob: (pathname) =>
      Effect.sync(() => Option.map(Option.fromUndefinedOr(stored.get(pathname)), view)),
    seed: (pathname, body, seedOptions) =>
      Effect.map(DateTime.now, (uploadedAt) => {
        const blob: StoredBlob = {
          pathname,
          access: seedOptions?.access ?? storeAccess,
          body: toBytes(body),
          contentType:
            seedOptions?.contentType ||
            (extensionMediaType(pathname) ?? requestContentTypeOf(body)),
          cacheControlMaxAge: maxAgeSeconds(seedOptions?.cacheControlMaxAge) ?? oneMonthSeconds,
          etag: nextEtag(),
          uploadedAt,
        };
        stored.set(pathname, blob);
        return view(blob);
      }),
    failNext: (operation, error) =>
      Effect.sync(() => {
        const queue = scripted.get(operation) ?? [];
        queue.push(error);
        scripted.set(operation, queue);
      }),
    serveUrl: (url, body, contentType) =>
      Effect.sync(() => {
        remotes.set(new URL(url).href, {
          body: toBytes(body),
          contentType: Option.fromUndefinedOr(contentType),
        });
      }),
  });

  return Context.make(BlobStore, api).pipe(Context.add(TestBlobStore, control));
}
