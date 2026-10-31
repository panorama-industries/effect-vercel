import { Duration } from "effect";

import type { BlobAccess } from "../contracts/blob-domain.ts";

/** Header carrying each write option, as the SDK's `putOptionHeaderMap`. */
export const writeOptionHeaders = {
  cacheControlMaxAge: "x-cache-control-max-age",
  addRandomSuffix: "x-add-random-suffix",
  allowOverwrite: "x-allow-overwrite",
  contentType: "x-content-type",
  access: "x-vercel-blob-access",
  ifMatch: "x-if-match",
} as const;

/** A write option an endpoint may accept; `access` is always sent and needs no listing. */
export type WriteOption = Exclude<keyof typeof writeOptionHeaders, "access">;

/**
 * Write options as any write operation receives them. `CreateBlobOptions`, `PutOptions` and the
 * client upload options are all assignable to it.
 */
export interface WriteHeaderOptions {
  readonly access: BlobAccess;
  readonly addRandomSuffix?: boolean | undefined;
  readonly allowOverwrite?: boolean | undefined;
  readonly contentType?: string | undefined;
  readonly cacheControlMaxAge?: Duration.Input | undefined;
  readonly ifMatch?: string | undefined;
}

/** The `allowedOptions` each SDK write method passes to `createPutHeaders`. */
export const allowedWriteOptions = {
  /** `put` (single and multipart), `createMultipartUpload`. */
  put: ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "contentType", "ifMatch"],
  /** `uploadPart` and `completeMultipartUpload`: no `ifMatch`. */
  multipartPart: ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "contentType"],
  /** `putImage`: the optimizer decides the media type. */
  putImage: ["cacheControlMaxAge", "addRandomSuffix", "allowOverwrite", "ifMatch"],
  /** Every browser (client token) write: the token fixes the rest. */
  client: ["contentType"],
} as const satisfies Record<string, ReadonlyArray<WriteOption>>;

/**
 * The cache lifetime in whole seconds, as sent in `x-cache-control-max-age`. Note that a bare
 * number is a `Duration.Input` in milliseconds.
 */
export const cacheControlMaxAgeSeconds = (maxAge: Duration.Input): number =>
  Math.floor(Duration.toSeconds(maxAge));

/**
 * Port of the SDK's `createPutHeaders`: the headers for the write options that `allowedOptions`
 * lists, plus `x-vercel-blob-access` always.
 *
 * Booleans are sent as `1`/`0`. `ifMatch` (when allowed and non-empty) implies
 * `x-allow-overwrite: 1` unless `allowOverwrite` is set explicitly; the option types already rule
 * out `ifMatch` with `allowOverwrite: false`. An empty `contentType` is not sent.
 */
export const writeHeaders = (
  allowedOptions: ReadonlyArray<WriteOption>,
  options: WriteHeaderOptions,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  headers[writeOptionHeaders.access] = options.access;

  if (allowedOptions.includes("contentType") && options.contentType) {
    headers[writeOptionHeaders.contentType] = options.contentType;
  }

  if (allowedOptions.includes("addRandomSuffix") && options.addRandomSuffix !== undefined) {
    headers[writeOptionHeaders.addRandomSuffix] = options.addRandomSuffix ? "1" : "0";
  }

  if (allowedOptions.includes("ifMatch") && options.ifMatch) {
    headers[writeOptionHeaders.ifMatch] = options.ifMatch;
    if (allowedOptions.includes("allowOverwrite") && options.allowOverwrite === undefined) {
      headers[writeOptionHeaders.allowOverwrite] = "1";
    }
  }

  if (allowedOptions.includes("allowOverwrite") && options.allowOverwrite !== undefined) {
    headers[writeOptionHeaders.allowOverwrite] = options.allowOverwrite ? "1" : "0";
  }

  if (allowedOptions.includes("cacheControlMaxAge") && options.cacheControlMaxAge !== undefined) {
    headers[writeOptionHeaders.cacheControlMaxAge] = String(
      cacheControlMaxAgeSeconds(options.cacheControlMaxAge),
    );
  }

  return headers;
};

/**
 * The write headers of `copy` and `rename`, which the SDK builds by hand: every option is sent when
 * set, and `ifMatch` (checked against the source) does not imply `x-allow-overwrite`.
 */
export const copyWriteHeaders = (options: WriteHeaderOptions): Record<string, string> => {
  const headers: Record<string, string> = {};
  headers[writeOptionHeaders.access] = options.access;
  if (options.addRandomSuffix !== undefined) {
    headers[writeOptionHeaders.addRandomSuffix] = options.addRandomSuffix ? "1" : "0";
  }
  if (options.allowOverwrite !== undefined) {
    headers[writeOptionHeaders.allowOverwrite] = options.allowOverwrite ? "1" : "0";
  }
  if (options.contentType) {
    headers[writeOptionHeaders.contentType] = options.contentType;
  }
  if (options.cacheControlMaxAge !== undefined) {
    headers[writeOptionHeaders.cacheControlMaxAge] = String(
      cacheControlMaxAgeSeconds(options.cacheControlMaxAge),
    );
  }
  if (options.ifMatch) {
    headers[writeOptionHeaders.ifMatch] = options.ifMatch;
  }
  return headers;
};
