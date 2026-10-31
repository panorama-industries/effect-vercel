import { DateTime, Effect, Option, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

import type { BlobAccess, DelegationOperation, StoreId } from "../contracts/blob-domain.ts";
import type { PresignOptions, SigningToken } from "../contracts/blob-signed-urls.ts";

import { PresignedUrlPayload } from "../contracts/blob-domain.ts";
import { BlobPresignFailed } from "../contracts/blob-errors.ts";
import { storeIdFromDelegationToken } from "./store-id.ts";
import { blobUrl, isUrl } from "./urls.ts";

/*
 * Presigned URLs, ported from the SDK's `signed-token.ts` (`presign`, `presignUrl`,
 * `canonicalString`) and `presign-query-params.ts`. The canonical string and query entries must
 * stay aligned with the Blob API and proxy that verify them.
 */

/** Signed expiry of one URL, when earlier than the delegation's. */
export const presignQueryValidUntil = "vercel-blob-valid-until";
/** Largest upload a presigned `put` accepts. */
export const presignQueryMaximumSize = "vercel-blob-maximum-size-in-bytes";
/** Media types a presigned `put` accepts, sorted and comma-separated. */
export const presignQueryAllowedContentTypes = "vercel-blob-allowed-content-types";
/** `true`/`false`. */
export const presignQueryAddRandomSuffix = "vercel-blob-add-random-suffix";
/** `true`/`false`. */
export const presignQueryAllowOverwrite = "vercel-blob-allow-overwrite";
/** Seconds. */
export const presignQueryCacheControlMaxAge = "vercel-blob-cache-control-max-age";
/** ETag a presigned `put` or `delete` requires. */
export const presignQueryIfMatch = "vercel-blob-if-match";
/** Where the store sends `blob.upload-completed`. */
export const presignQueryCallbackUrl = "vercel-blob-callback-url";
/** `tokenPayload` of the upload-completed callback. */
export const presignQueryCallbackTokenPayload = "vercel-blob-callback-token-payload";

/** Every signed constraint, in UTF-8 order, as the SDK's `PRESIGN_CANONICAL_QUERY_KEYS`. */
export const presignCanonicalQueryKeys = [
  presignQueryAddRandomSuffix,
  presignQueryAllowOverwrite,
  presignQueryAllowedContentTypes,
  presignQueryCacheControlMaxAge,
  presignQueryCallbackTokenPayload,
  presignQueryCallbackUrl,
  presignQueryIfMatch,
  presignQueryMaximumSize,
  presignQueryValidUntil,
] as const;

/** Longest `onUploadCompleted.callbackUrl` a presigned URL may carry. */
export const maximumPresignCallbackUrlLength = 4096;

/** Longest `onUploadCompleted.tokenPayload` a presigned URL may carry. */
export const maximumPresignCallbackTokenPayloadLength = 8192;

/** Largest `cacheControlMaxAge` a presigned URL may carry: one year, in seconds. */
export const maximumPresignCacheControlMaxAge = 365 * 24 * 60 * 60;

const maximumIfMatchLength = 256;

// oxlint-disable-next-line no-control-regex -- control characters are what it rejects
const ifMatchControlCharacters = /[\x00-\x1f\x7f]/;

const label = "presignUrl";

/** One signed query parameter. */
export type PresignQueryEntry = readonly [key: string, value: string];

/** What a delegation token's payload constrains, as the SDK reads it for presigning. */
export const DelegationScope = Schema.Struct({
  pathname: Schema.optionalKey(Schema.String),
  operations: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Epoch milliseconds. */
  validUntil: Schema.optionalKey(Schema.Number),
  maximumSizeInBytes: Schema.optionalKey(Schema.Number),
  allowedContentTypes: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** What a delegation token's payload constrains. */
export type DelegationScope = typeof DelegationScope.Type;

const decodeScope = Schema.decodeUnknownOption(Schema.fromJsonString(DelegationScope));

/**
 * Read the scope of a delegation token: the base64url JSON before its first `.`. Standard base64
 * characters and padding are accepted, as the SDK's decoder accepts them.
 *
 * @returns None when the token has no `.` or the segment is not base64url JSON of an object.
 */
export const delegationScope = (delegationToken: string): Option.Option<DelegationScope> => {
  const dot = delegationToken.indexOf(".");
  if (dot < 0) {
    return Option.none();
  }
  const segment = delegationToken
    .slice(0, dot)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return Result.getSuccess(Base64Url.decodeString(segment)).pipe(Option.flatMap(decodeScope));
};

const utf8 = new TextEncoder();

/** Bytewise UTF-8 order, as the SDK's `compareUtf8` (Go string order). */
const compareUtf8 = (a: string, b: string): number => {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const difference = left[i]! - right[i]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
};

/**
 * The string a presigned URL's signature covers, as the SDK's `canonicalString`: `operation=…`,
 * `pathname=…` and every non-empty signed entry as `key=value`, sorted bytewise and joined by `\n`.
 */
export const canonicalString = (
  pathname: string,
  entries: ReadonlyArray<PresignQueryEntry>,
  operation: DelegationOperation,
): string => {
  const lines = [`operation=${operation}`, `pathname=${pathname}`];
  for (const key of presignCanonicalQueryKeys) {
    const value = entries.find(([entry]) => entry === key)?.[1];
    if (value) {
      lines.push(`${key}=${value}`);
    }
  }
  return lines.sort(compareUtf8).join("\n");
};

/** HMAC-SHA256 of `data` keyed by `secret` (both UTF-8), as unpadded base64url. */
export const hmacSha256Base64Url = Effect.fnUntraced(function* (secret: string, data: string) {
  const key = yield* Effect.promise(() =>
    globalThis.crypto.subtle.importKey(
      "raw",
      utf8.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );
  const signature = yield* Effect.promise(() =>
    globalThis.crypto.subtle.sign("HMAC", key, utf8.encode(data)),
  );
  return Base64Url.encode(new Uint8Array(signature));
});

const failed = (message: string) => Effect.fail(new BlobPresignFailed({ message }));

/** Signed constraints of one presigned URL, in epoch milliseconds and seconds as on the wire. */
export interface PresignUrlConstraints {
  readonly validUntil?: number | undefined;
  readonly allowedContentTypes?: ReadonlyArray<string> | undefined;
  readonly maximumSizeInBytes?: number | undefined;
  readonly addRandomSuffix?: boolean | undefined;
  readonly allowOverwrite?: boolean | undefined;
  readonly cacheControlMaxAge?: number | undefined;
  readonly ifMatch?: string | undefined;
  readonly onUploadCompleted?:
    | { readonly callbackUrl: string; readonly tokenPayload?: string | null | undefined }
    | undefined;
}

/** What the delegation allows, as the SDK's `DelegationScopeForPresign`. */
export interface PresignDelegation {
  /** Epoch milliseconds; none when the delegation states no expiry. */
  readonly validUntil: number | undefined;
  readonly maximumSizeInBytes?: number | undefined;
  readonly allowedContentTypes?: ReadonlyArray<string> | undefined;
}

const contentTypeAllowed = (contentType: string, allowed: ReadonlyArray<string>): boolean => {
  const [type] = contentType.split("/");
  return allowed.includes(contentType) || (type ? allowed.includes(`${type}/*`) : false);
};

/**
 * The URL's expiry, as the SDK's `resolvePresignUrlValidUntilMs`: the requested one capped to the
 * delegation's, which must be after `now`. A delegation without an expiry and no requested one
 * yields `NaN`, as in the SDK, which then signs no expiry.
 */
const resolveValidUntil = (
  delegationValidUntil: number | undefined,
  requested: number | undefined,
  now: number,
) => {
  let until = Math.trunc(requested ?? delegationValidUntil ?? Number.NaN);
  if (delegationValidUntil !== undefined && Number.isFinite(delegationValidUntil)) {
    until = Math.min(until, Math.trunc(delegationValidUntil));
  }
  if (until <= now) {
    return failed(
      `${label}: resolved URL expiry is not after the current time; issue a new delegation token or pass a later validUntil.`,
    );
  }
  return Effect.succeed(until);
};

const validateUploadConstraints = Effect.fnUntraced(function* (
  options: PresignUrlConstraints,
  delegation: PresignDelegation,
) {
  const allowed = delegation.allowedContentTypes;
  if (options.allowedContentTypes?.length && allowed?.length) {
    for (const contentType of options.allowedContentTypes) {
      if (!contentTypeAllowed(contentType, allowed)) {
        return yield* failed(
          `${label}: allowedContentTypes entry "${contentType}" is not permitted by the delegation token.`,
        );
      }
    }
  }
  if (
    options.maximumSizeInBytes !== undefined &&
    delegation.maximumSizeInBytes !== undefined &&
    options.maximumSizeInBytes > delegation.maximumSizeInBytes
  ) {
    return yield* failed(
      `${label}: maximumSizeInBytes must be ≤ delegation (${String(delegation.maximumSizeInBytes)}).`,
    );
  }
  const maxAge = options.cacheControlMaxAge;
  if (
    maxAge !== undefined &&
    (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > maximumPresignCacheControlMaxAge)
  ) {
    return yield* failed(
      `${label}: cacheControlMaxAge must be an integer between 0 and ${maximumPresignCacheControlMaxAge}.`,
    );
  }
  const ifMatch = options.ifMatch;
  if (ifMatch !== undefined) {
    if (ifMatch.length === 0) {
      return yield* failed(`${label}: ifMatch must be a non-empty string.`);
    }
    if (ifMatch.length > maximumIfMatchLength) {
      return yield* failed(`${label}: ifMatch is too long.`);
    }
    if (ifMatchControlCharacters.test(ifMatch)) {
      return yield* failed(`${label}: ifMatch contains disallowed control characters.`);
    }
  }
  const callback = options.onUploadCompleted;
  if (callback !== undefined) {
    if (callback.callbackUrl.length === 0) {
      return yield* failed(`${label}: onUploadCompleted.callbackUrl must be a non-empty string.`);
    }
    if (callback.callbackUrl.length > maximumPresignCallbackUrlLength) {
      return yield* failed(`${label}: onUploadCompleted.callbackUrl is too long.`);
    }
    if (!URL.canParse(callback.callbackUrl)) {
      return yield* failed(`${label}: onUploadCompleted.callbackUrl must be a valid URL.`);
    }
    if (
      callback.tokenPayload !== undefined &&
      callback.tokenPayload !== null &&
      callback.tokenPayload.length > maximumPresignCallbackTokenPayloadLength
    ) {
      return yield* failed(`${label}: onUploadCompleted.tokenPayload is too long.`);
    }
  }
});

const sortedCsv = (types: ReadonlyArray<string>): string =>
  [...types].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",");

/**
 * The signed query entries of one presigned URL, as the SDK's `buildPresignCanonicalQueryEntries`,
 * in the same order. `vercel-blob-valid-until` is left out when it equals the delegation's expiry;
 * `get` and `head` sign only the expiry, `delete` also `ifMatch`, and `put` every constraint after
 * checking that each one only narrows the delegation's.
 */
export const presignCanonicalQueryEntries = Effect.fnUntraced(function* (args: {
  readonly operation: DelegationOperation;
  readonly delegation: PresignDelegation;
  readonly urlOptions: PresignUrlConstraints;
  readonly now: number;
}) {
  const { operation, delegation, urlOptions, now } = args;
  const until = yield* resolveValidUntil(delegation.validUntil, urlOptions.validUntil, now);
  const entries: Array<PresignQueryEntry> = [];
  if (until < Math.trunc(delegation.validUntil ?? Number.NaN)) {
    entries.push([presignQueryValidUntil, String(until)]);
  }

  if (operation === "delete") {
    if (urlOptions.ifMatch !== undefined) {
      entries.push([presignQueryIfMatch, urlOptions.ifMatch]);
    }
    return entries;
  }
  if (operation !== "put") {
    return entries;
  }

  yield* validateUploadConstraints(urlOptions, delegation);

  if (urlOptions.allowedContentTypes !== undefined) {
    const csv = sortedCsv(urlOptions.allowedContentTypes);
    if (csv.length > 16_384) {
      return yield* failed(`${label}: allowedContentTypes query value is too long.`);
    }
    entries.push([presignQueryAllowedContentTypes, csv]);
  }
  if (urlOptions.maximumSizeInBytes !== undefined) {
    entries.push([presignQueryMaximumSize, String(Math.trunc(urlOptions.maximumSizeInBytes))]);
  }
  if (urlOptions.addRandomSuffix !== undefined) {
    entries.push([presignQueryAddRandomSuffix, urlOptions.addRandomSuffix ? "true" : "false"]);
  }
  if (urlOptions.allowOverwrite !== undefined) {
    entries.push([presignQueryAllowOverwrite, urlOptions.allowOverwrite ? "true" : "false"]);
  }
  if (urlOptions.cacheControlMaxAge !== undefined) {
    entries.push([
      presignQueryCacheControlMaxAge,
      String(Math.trunc(urlOptions.cacheControlMaxAge)),
    ]);
  }
  if (urlOptions.ifMatch !== undefined) {
    entries.push([presignQueryIfMatch, urlOptions.ifMatch]);
  }
  if (urlOptions.onUploadCompleted !== undefined) {
    const { callbackUrl, tokenPayload } = urlOptions.onUploadCompleted;
    entries.push([presignQueryCallbackUrl, callbackUrl]);
    if (tokenPayload !== undefined && tokenPayload !== null && tokenPayload !== "") {
      entries.push([presignQueryCallbackTokenPayload, tokenPayload]);
    }
  }
  return entries;
});

const epochMillis = (value: DateTime.Utc | undefined): number | undefined =>
  value === undefined ? undefined : DateTime.toEpochMillis(value);

/** The signed constraints of {@link PresignOptions}, in wire units. */
const urlConstraints = (options: PresignOptions): PresignUrlConstraints => {
  const validUntil = epochMillis(options.validUntil);
  switch (options.operation) {
    case "get":
    case "head":
      return { validUntil };
    case "delete":
      return { validUntil, ifMatch: options.ifMatch };
    case "put":
      return {
        validUntil,
        allowedContentTypes: options.allowedContentTypes,
        maximumSizeInBytes: options.maximumSizeInBytes,
        addRandomSuffix: options.addRandomSuffix,
        allowOverwrite: options.allowOverwrite,
        cacheControlMaxAge: options.cacheControlMaxAge,
        ifMatch: options.ifMatch,
        onUploadCompleted: options.onUploadCompleted,
      };
  }
};

const operationNotDelegated: Record<DelegationOperation, string> = {
  get: 'The delegation token is not valid for `GET` requests. Include `"get"` in `operations` when calling `issueSignedToken`.',
  head: 'The delegation token is not valid for `HEAD` requests. Include `"head"` in `operations` when calling `issueSignedToken`.',
  put: 'The delegation token is not valid for presigned write requests. Include `"put"` in `operations` when calling `issueSignedToken`.',
  delete:
    'The delegation token is not valid for presigned delete requests. Include `"delete"` in `operations` when calling `issueSignedToken`.',
};

/**
 * Sign one request with a signed token, as the SDK's `presign`: check the delegation's pathname,
 * expiry and operations, build the signed query entries, and HMAC their canonical string with the
 * client signing token.
 *
 * @param now - Current time in epoch milliseconds.
 * @returns The payload, or `BlobPresignFailed` with the SDK's message.
 */
export const presignPayload = Effect.fnUntraced(function* (
  token: SigningToken,
  options: PresignOptions,
  now: number,
) {
  const clientSigningToken = Redacted.value(token.clientSigningToken);
  if (!clientSigningToken || !token.delegationToken) {
    return yield* failed(
      "`clientSigningToken` and `delegationToken` from `issueSignedToken` are required.",
    );
  }
  const scope = delegationScope(token.delegationToken);
  if (Option.isNone(scope)) {
    return yield* failed("Invalid or unreadable `delegationToken` payload.");
  }
  const { pathname, validUntil, operations, maximumSizeInBytes, allowedContentTypes } = scope.value;
  if (pathname && pathname !== "*" && options.pathname !== pathname) {
    return yield* failed(
      `Blob path does not match the signed token scope; expected \`${pathname}\`, got \`${options.pathname}\`.`,
    );
  }
  if (validUntil !== undefined && Number.isFinite(validUntil) && now > validUntil) {
    return yield* failed("The signed delegation has expired; issue a new token first.");
  }
  if (!operations?.includes(options.operation)) {
    return yield* failed(operationNotDelegated[options.operation]);
  }

  const entries = yield* presignCanonicalQueryEntries({
    operation: options.operation,
    delegation: { validUntil, maximumSizeInBytes, allowedContentTypes },
    urlOptions: urlConstraints(options),
    now,
  });
  const signature = yield* hmacSha256Base64Url(
    clientSigningToken,
    canonicalString(options.pathname, entries, options.operation),
  );
  return new PresignedUrlPayload({
    delegationToken: token.delegationToken,
    signature,
    params: Object.fromEntries(entries),
  });
});

/** `url` with the payload's params, `vercel-blob-delegation` and `vercel-blob-signature` set. */
export const withPresignedParams = (url: URL, payload: PresignedUrlPayload): URL => {
  const result = new URL(url);
  for (const [key, value] of Object.entries(payload.params)) {
    result.searchParams.set(key, value);
  }
  result.searchParams.set("vercel-blob-delegation", payload.delegationToken);
  result.searchParams.set("vercel-blob-signature", payload.signature);
  return result;
};

/**
 * The presigned URL of a `get` or `head`, as the SDK's `buildPresignedGetUrl`: a blob URL is used
 * as is, a pathname is resolved under the delegation's store (`blobBaseUrl`); `cache=0` (unsigned)
 * is added for a private `get` with `useCache: false`.
 *
 * @returns None when the delegation token carries no valid store id, which the SDK requires even
 *   for a blob URL.
 */
export const presignedBlobUrl = (args: {
  readonly pathnameOrUrl: string;
  readonly payload: PresignedUrlPayload;
  readonly access: BlobAccess;
  readonly useCache: boolean | undefined;
  readonly blobBaseUrl: (storeId: StoreId, access: BlobAccess) => URL;
}): Option.Option<URL> =>
  Option.map(storeIdFromDelegationToken(args.payload.delegationToken), (storeId) => {
    const url = isUrl(args.pathnameOrUrl)
      ? new URL(args.pathnameOrUrl)
      : blobUrl(args.blobBaseUrl(storeId, args.access), args.pathnameOrUrl);
    if (args.useCache === false && args.access === "private") {
      url.searchParams.set("cache", "0");
    }
    return withPresignedParams(url, args.payload);
  });

/**
 * The presigned URL of a `put` or `delete`, as the SDK's `buildPresignedPutUrl`: the Blob API's
 * `/?pathname=…` (trailing slashes of `apiUrl` removed) plus the payload's params.
 */
export const presignedApiUrl = (
  apiUrl: URL,
  pathname: string,
  payload: PresignedUrlPayload,
): URL => {
  const base = apiUrl.href.replace(/\/+$/, "");
  return withPresignedParams(
    new URL(`${base}/?${new URLSearchParams({ pathname }).toString()}`),
    payload,
  );
};
