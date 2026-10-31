import { Duration, Effect, Stream, SynchronizedRef } from "effect";

import type {
  BlobBody,
  BlobPathname,
  OnUploadProgress,
  PutBlobResult,
  UploadProgress,
} from "../contracts/blob-domain.ts";
import type { BlobApiError, BlobDomainErrorTag } from "./blob-errors.ts";
import type { BlobRequestAuth, BlobRequester } from "./blob-request.ts";
import type { WriteHeaderOptions, WriteOption } from "./write-headers.ts";

import { MultipartUpload, UploadedPart } from "../contracts/blob-domain.ts";
import { BlobUploadRejected, FileTooLarge } from "../contracts/blob-errors.ts";
import { bodyLength, uploadProgressThrottle } from "./blob-request.ts";
import { CreateMultipartUploadResponse, PutBlobResponse, UploadPartResponse } from "./wire.ts";
import { allowedWriteOptions, cacheControlMaxAgeSeconds, writeHeaders } from "./write-headers.ts";

/*
 * Multipart uploads, shared by the server `BlobStore` and the browser `BlobClient`: the manual
 * primitives (create, upload a part, complete) and the automatic upload behind `put({ multipart })`,
 * ported from the SDK's `multipart/*.ts` and `uncontrolledMultipartUpload`.
 */

/** Size of the parts an automatic multipart upload sends, as the SDK's `partSizeInBytes`. */
export const multipartPartSize = 8 * 1024 * 1024;

/** Minimum time between progress events of an automatic multipart upload, as in the SDK. */
export const multipartProgressInterval = Duration.millis(150);

/**
 * How many parts an automatic multipart upload sends at once, as the SDK's `maxConcurrentUploads`:
 * 6 in browsers (where `window` is defined), which allow about six connections per host, and 8
 * elsewhere. Read on every call.
 */
export const maxConcurrentPartUploads = (): number =>
  (globalThis as { readonly window?: unknown }).window === undefined ? 8 : 6;

/**
 * Which write options become headers at each step. Creation (and every request of an automatic
 * upload, which the SDK sends with the `put` headers throughout) uses `create`; `uploadPart` and
 * `completeMultipartUpload` rebuild their headers from the {@link MultipartUpload} handle with
 * `part`.
 */
export interface MultipartWriteOptions {
  readonly create: ReadonlyArray<WriteOption>;
  readonly part: ReadonlyArray<WriteOption>;
}

/** The SDK's server lists: every option at creation, all but `ifMatch` for parts and completion. */
export const serverMultipartWriteOptions: MultipartWriteOptions = {
  create: allowedWriteOptions.put,
  part: allowedWriteOptions.multipartPart,
};

/** The SDK's client-token lists: only `contentType` (and `access`); the token fixes the rest. */
export const clientMultipartWriteOptions: MultipartWriteOptions = {
  create: allowedWriteOptions.client,
  part: allowedWriteOptions.client,
};

/**
 * Where and how multipart requests are sent. Build it once per layer for the server; the browser
 * client builds one per call because its auth (client token or presigned payload) is per upload.
 *
 * @template EA - Failure of `auth`, such as `OidcTokenUnavailable`.
 * @template RA - Requirements of `auth`.
 * @template K - Domain errors the calling service's contract declares for writes.
 */
export interface MultipartTarget<EA, RA, K extends BlobDomainErrorTag> {
  readonly requester: BlobRequester;

  /** Evaluated once per request, so refreshed OIDC tokens are picked up between parts. */
  readonly auth: Effect.Effect<BlobRequestAuth, EA, RA>;

  /**
   * Prefix of the operation names in errors and spans: `BlobStore` or `BlobClient`. Requests are
   * named `<service>.createMultipartUpload`, `<service>.uploadPart` and
   * `<service>.completeMultipartUpload`.
   */
  readonly service: string;

  readonly domainErrors: ReadonlyArray<K>;

  readonly writeOptions: MultipartWriteOptions;
}

/** A part as the complete request sends it; `UploadedPart` and plain records both fit. */
export interface CompletedPart {
  readonly etag: string;
  readonly partNumber: number;
}

const mpuPath = (pathname: string): string =>
  `/mpu?${new URLSearchParams({ pathname }).toString()}`;

/** The handle's write options, filtered to what creation sent, with the cache lifetime in seconds. */
const handleWriteOptions = (
  allowed: ReadonlyArray<WriteOption>,
  options: WriteHeaderOptions,
): Omit<ConstructorParameters<typeof MultipartUpload>[0], "pathname" | "key" | "uploadId"> => ({
  access: options.access,
  ...(allowed.includes("addRandomSuffix") && options.addRandomSuffix !== undefined
    ? { addRandomSuffix: options.addRandomSuffix }
    : {}),
  ...(allowed.includes("allowOverwrite") && options.allowOverwrite !== undefined
    ? { allowOverwrite: options.allowOverwrite }
    : {}),
  ...(allowed.includes("contentType") && options.contentType
    ? { contentType: options.contentType }
    : {}),
  ...(allowed.includes("cacheControlMaxAge") && options.cacheControlMaxAge !== undefined
    ? { cacheControlMaxAge: cacheControlMaxAgeSeconds(options.cacheControlMaxAge) }
    : {}),
});

/** The write options a handle carries, back in the form `writeHeaders` reads. */
const uploadWriteOptions = (upload: MultipartUpload): WriteHeaderOptions => ({
  access: upload.access,
  addRandomSuffix: upload.addRandomSuffix,
  allowOverwrite: upload.allowOverwrite,
  contentType: upload.contentType,
  cacheControlMaxAge:
    upload.cacheControlMaxAge === undefined
      ? undefined
      : Duration.seconds(upload.cacheControlMaxAge),
});

/** One protocol step, with the write headers already computed. */
interface Step<EA, RA, K extends BlobDomainErrorTag> {
  readonly target: MultipartTarget<EA, RA, K>;
  readonly pathname: string;
  readonly headers: Readonly<Record<string, string>>;
}

const createRequest = <EA, RA, K extends BlobDomainErrorTag>({
  target,
  pathname,
  headers,
}: Step<EA, RA, K>): Effect.Effect<
  typeof CreateMultipartUploadResponse.Type,
  BlobApiError<K> | EA,
  RA
> =>
  target.requester.call({
    operation: `${target.service}.createMultipartUpload`,
    method: "POST",
    path: mpuPath(pathname),
    auth: target.auth,
    response: CreateMultipartUploadResponse,
    headers: { ...headers, "x-mpu-action": "create" },
    locator: pathname,
    domainErrors: target.domainErrors,
  });

const uploadPartRequest = <EA, RA, K extends BlobDomainErrorTag, E = never, R = never>(
  { target, pathname, headers }: Step<EA, RA, K>,
  part: {
    readonly key: string;
    readonly uploadId: string;
    readonly partNumber: number;
    readonly body: BlobBody<E, R>;
    readonly onUploadProgress?: OnUploadProgress | undefined;
    /** Sent as `content-type`; automatic parts are typed `application/octet-stream` like the SDK's. */
    readonly contentType?: string | undefined;
  },
): Effect.Effect<typeof UploadPartResponse.Type, BlobApiError<K> | EA | E, RA | R> =>
  target.requester.call({
    operation: `${target.service}.uploadPart`,
    method: "POST",
    path: mpuPath(pathname),
    auth: target.auth,
    response: UploadPartResponse,
    headers: {
      ...headers,
      "x-mpu-action": "upload",
      // The key can hold any UTF-8 character, and header values must be US-ASCII.
      "x-mpu-key": encodeURIComponent(part.key),
      "x-mpu-upload-id": part.uploadId,
      "x-mpu-part-number": String(part.partNumber),
      ...(part.contentType === undefined ? {} : { "content-type": part.contentType }),
    },
    body: part.body,
    locator: pathname,
    domainErrors: target.domainErrors,
    onUploadProgress: part.onUploadProgress,
  });

const completeRequest = <EA, RA, K extends BlobDomainErrorTag>(
  { target, pathname, headers }: Step<EA, RA, K>,
  upload: {
    readonly key: string;
    readonly uploadId: string;
    readonly parts: ReadonlyArray<CompletedPart>;
    /**
     * Serialize parts as `{ partNumber, etag }`, the field order of the SDK's automatic upload;
     * manual completion passes the caller's `{ etag, partNumber }` through.
     */
    readonly partNumberFirst?: boolean | undefined;
  },
): Effect.Effect<PutBlobResult, BlobApiError<K> | EA, RA> =>
  target.requester.call({
    operation: `${target.service}.completeMultipartUpload`,
    method: "POST",
    path: mpuPath(pathname),
    auth: target.auth,
    response: PutBlobResponse,
    headers: {
      ...headers,
      "x-mpu-action": "complete",
      "x-mpu-upload-id": upload.uploadId,
      "x-mpu-key": encodeURIComponent(upload.key),
    },
    // `content-type: application/json` comes with `json`; fields in the SDK's order.
    json: upload.parts.map(({ etag, partNumber }) =>
      upload.partNumberFirst === true ? { partNumber, etag } : { etag, partNumber },
    ),
    locator: pathname,
    domainErrors: target.domainErrors,
  });

/**
 * Start a multipart upload: `POST /mpu?pathname=…` with `x-mpu-action: create` and the
 * `writeOptions.create` headers.
 *
 * @returns The handle: pathname, the store's key and upload id, `access` and every write option
 *   creation sent (cache lifetime in seconds), so parts and completion resend the same headers.
 */
export const createMultipartUpload = Effect.fnUntraced(function* <
  EA,
  RA,
  K extends BlobDomainErrorTag,
>(
  target: MultipartTarget<EA, RA, K>,
  pathname: BlobPathname,
  options: WriteHeaderOptions,
): Effect.fn.Return<MultipartUpload, BlobApiError<K> | EA, RA> {
  const allowed = target.writeOptions.create;
  const { key, uploadId } = yield* createRequest({
    target,
    pathname,
    headers: writeHeaders(allowed, options),
  });
  return new MultipartUpload({
    pathname,
    key,
    uploadId,
    ...handleWriteOptions(allowed, options),
  });
});

/**
 * Upload one part: `POST /mpu?pathname=…` with `x-mpu-action: upload`, `x-mpu-key`
 * (URI-encoded), `x-mpu-upload-id`, `x-mpu-part-number` and the `writeOptions.part` headers
 * rebuilt from the handle. The body is sent as given; a `Stream` body is not retried.
 */
export const uploadPart = Effect.fnUntraced(function* <
  EA,
  RA,
  K extends BlobDomainErrorTag,
  E = never,
  R = never,
>(
  target: MultipartTarget<EA, RA, K>,
  upload: MultipartUpload,
  partNumber: UploadedPart["partNumber"],
  body: BlobBody<E, R>,
): Effect.fn.Return<UploadedPart, BlobApiError<K> | EA | E, RA | R> {
  const { etag } = yield* uploadPartRequest(
    {
      target,
      pathname: upload.pathname,
      headers: writeHeaders(target.writeOptions.part, uploadWriteOptions(upload)),
    },
    { key: upload.key, uploadId: upload.uploadId, partNumber, body },
  );
  return new UploadedPart({ etag, partNumber });
});

/**
 * Assemble the parts into the blob: `POST /mpu?pathname=…` with `x-mpu-action: complete`, the
 * `writeOptions.part` headers rebuilt from the handle, and the JSON array
 * `[{"etag","partNumber"}, …]` in the order given.
 */
export const completeMultipartUpload = <EA, RA, K extends BlobDomainErrorTag>(
  target: MultipartTarget<EA, RA, K>,
  upload: MultipartUpload,
  parts: ReadonlyArray<CompletedPart>,
) =>
  completeRequest(
    {
      target,
      pathname: upload.pathname,
      headers: writeHeaders(target.writeOptions.part, uploadWriteOptions(upload)),
    },
    { key: upload.key, uploadId: upload.uploadId, parts },
  );

/** Options of an automatic multipart upload. */
export type MultipartPutOptions = WriteHeaderOptions & {
  /**
   * Fail with `BlobUploadRejected` / `FileTooLarge` before any request when the body's known size
   * is larger. Streams are not checked.
   */
  readonly maximumSizeInBytes?: number | undefined;

  readonly onUploadProgress?: OnUploadProgress | undefined;

  /** Parts sent at once; {@link maxConcurrentPartUploads} by default. */
  readonly concurrency?: number | undefined;
};

/** A part to upload: its bytes, read when an upload slot is free. */
type PartSource = Effect.Effect<Uint8Array>;

/**
 * Regroup a byte stream into parts of exactly `size` bytes, the last one smaller, copying each
 * byte once into its part (the SDK cuts parts the same way, because R2 refuses uneven parts).
 */
const regroupParts =
  (size: number) =>
  <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
    Stream.mapAccum(
      stream,
      (): { readonly part: Uint8Array | undefined; readonly filled: number } => ({
        part: undefined,
        filled: 0,
      }),
      (state, chunk: Uint8Array) => {
        let { part, filled } = state;
        const full: Array<Uint8Array> = [];
        let position = 0;
        while (position < chunk.length) {
          part ??= new Uint8Array(size);
          const count = Math.min(size - filled, chunk.length - position);
          part.set(chunk.subarray(position, position + count), filled);
          filled += count;
          position += count;
          if (filled === size) {
            full.push(part);
            part = undefined;
            filled = 0;
          }
        }
        return [{ part, filled }, full] as const;
      },
      {
        onHalt: ({ part, filled }) =>
          part === undefined || filled === 0 ? [] : [part.slice(0, filled)],
      },
    );

const partRanges = (length: number, size: number): ReadonlyArray<readonly [number, number]> =>
  Array.from({ length: Math.ceil(length / size) }, (_, index) => [
    index * size,
    Math.min(length, (index + 1) * size),
  ]);

const textEncoder = new TextEncoder();

const isBlob = (body: unknown): body is globalThis.Blob =>
  typeof globalThis.Blob !== "undefined" && body instanceof globalThis.Blob;

/**
 * The body cut into parts, each one plain bytes so it can be retried and sent by browsers that
 * cannot stream request bodies. In-memory bodies are cut into views without copying; a `Blob` is
 * sliced and each slice read only when its upload starts; a stream is regrouped as it is read.
 */
const bodyParts = <E, R>(body: BlobBody<E, R>, size: number): Stream.Stream<PartSource, E, R> => {
  if (typeof body === "string" || body instanceof Uint8Array) {
    const bytes = typeof body === "string" ? textEncoder.encode(body) : body;
    return Stream.fromIterable(
      partRanges(bytes.length, size).map(([start, end]) =>
        Effect.succeed(bytes.subarray(start, end)),
      ),
    );
  }
  if (isBlob(body)) {
    // A Blob that cannot be read is a defect, as in `bodyStream`.
    return Stream.fromIterable(
      partRanges(body.size, size).map(([start, end]) =>
        Effect.map(
          Effect.promise(() => body.slice(start, end).arrayBuffer()),
          (buffer) => new Uint8Array(buffer),
        ),
      ),
    );
  }
  return body.pipe(regroupParts(size), Stream.map(Effect.succeed));
};

const sumLoaded = (loadedByPart: ReadonlyMap<number, number>): number => {
  let loaded = 0;
  for (const partLoaded of loadedByPart.values()) loaded += partLoaded;
  return loaded;
};

/** The SDK's aggregate event: bytes sent by every part, against the body's known size. */
const aggregateProgress = (
  loadedByPart: ReadonlyMap<number, number>,
  totalToLoad: number,
): UploadProgress => {
  const loaded = sumLoaded(loadedByPart);
  return {
    loaded,
    total: totalToLoad || loaded,
    percentage: totalToLoad > 0 ? Number(((loaded / totalToLoad) * 100).toFixed(2)) : 0,
  };
};

/**
 * Upload a body with a multipart upload, as the SDK's `uncontrolledMultipartUpload`: create it,
 * send the body in {@link multipartPartSize} parts (the last one smaller) with bounded concurrency,
 * then complete it with the parts in part-number order. Every request carries the
 * `writeOptions.create` headers, as the SDK resends the `put` headers.
 *
 * - `maximumSizeInBytes` is checked against the known size before any request.
 * - Memory stays bounded: a part's bytes are produced only when an upload slot is free, so at most
 *   `concurrency` parts (plus the parts cut from the stream chunk being read) are held at once.
 * - The first failure, of a part or of the body stream, interrupts the parts in flight; the upload
 *   is then not completed.
 * - An empty body uploads no part and completes with an empty part list, as the SDK does.
 * - Progress: 0 % once the upload is created, then the bytes sent by all parts summed and
 *   throttled to one event per {@link multipartProgressInterval} (the SDK's numbers, rounded to two
 *   decimals). The event in which every byte has been acknowledged is held back, and
 *   `{ loaded, total: loaded, percentage: 100 }` is reported once the upload is completed instead.
 *
 * @returns The stored blob; fails with `BlobUploadRejected` for an oversized body, the requests'
 *   errors, or the body stream's error.
 */
export const multipartPut = Effect.fnUntraced(function* <
  EA,
  RA,
  K extends BlobDomainErrorTag,
  E = never,
  R = never,
>(
  target: MultipartTarget<EA, RA, K>,
  pathname: BlobPathname,
  body: BlobBody<E, R>,
  options: MultipartPutOptions,
): Effect.fn.Return<PutBlobResult, BlobApiError<K> | BlobUploadRejected | EA | E, RA | R> {
  const totalToLoad = bodyLength(body);
  const maximum = options.maximumSizeInBytes;
  if (maximum !== undefined && !Stream.isStream(body) && totalToLoad > maximum) {
    return yield* new BlobUploadRejected({
      reason: new FileTooLarge({
        message: `Body size of ${totalToLoad} bytes exceeds the maximum allowed size of ${maximum} bytes`,
      }),
    });
  }

  const step: Step<EA, RA, K> = {
    target,
    pathname,
    headers: writeHeaders(target.writeOptions.create, options),
  };
  const service = target.service;

  const { key, uploadId } = yield* createRequest(step).pipe(
    Effect.withSpan(`${service}.createMultipartUpload`),
  );

  const onUploadProgress = options.onUploadProgress;
  const loadedByPart = yield* SynchronizedRef.make<ReadonlyMap<number, number>>(new Map());

  const uploadParts = (
    report: ((partNumber: number) => OnUploadProgress) | undefined,
  ): Effect.Effect<Array<CompletedPart>, BlobApiError<K> | EA | E, RA | R> =>
    bodyParts(body, multipartPartSize).pipe(
      Stream.mapEffect(
        (source, index) =>
          Effect.gen(function* () {
            const partNumber = index + 1;
            const bytes = yield* source;
            const { etag } = yield* uploadPartRequest(step, {
              key,
              uploadId,
              partNumber,
              body: bytes,
              onUploadProgress: report?.(partNumber),
              contentType: "application/octet-stream",
            });
            return { etag, partNumber };
          }).pipe(
            Effect.withSpan(`${service}.uploadPart`, { attributes: { partNumber: index + 1 } }),
          ),
        { concurrency: options.concurrency ?? maxConcurrentPartUploads(), unordered: true },
      ),
      Stream.runCollect,
    );

  const complete = (parts: ReadonlyArray<CompletedPart>) =>
    completeRequest(step, {
      key,
      uploadId,
      parts: [...parts].sort((a, b) => a.partNumber - b.partNumber),
      partNumberFirst: true,
    }).pipe(Effect.withSpan(`${service}.completeMultipartUpload`));

  if (onUploadProgress === undefined) {
    return yield* Effect.flatMap(uploadParts(undefined), complete);
  }

  yield* onUploadProgress({ loaded: 0, total: totalToLoad, percentage: 0 });
  const reporter = yield* uploadProgressThrottle(onUploadProgress, multipartProgressInterval);
  // Updating the sums and offering the event under one lock keeps events in sending order. The SDK
  // also reports the aggregate in which every byte is acknowledged; it is left for the final event.
  const partProgress =
    (partNumber: number): OnUploadProgress =>
    (progress) =>
      SynchronizedRef.updateEffect(loadedByPart, (current) => {
        const next = new Map(current).set(partNumber, progress.loaded);
        const event = aggregateProgress(next, totalToLoad);
        const acknowledged = totalToLoad > 0 && event.loaded >= totalToLoad;
        return Effect.as(acknowledged ? Effect.void : reporter.report(event), next);
      });
  const blob = yield* uploadParts(partProgress).pipe(
    Effect.flatMap(complete),
    Effect.ensuring(reporter.stop),
  );
  const loaded = sumLoaded(yield* SynchronizedRef.get(loadedByPart));
  yield* onUploadProgress({ loaded, total: loaded, percentage: 100 });
  return blob;
});
