import { Effect, Option, Result, Schema } from "effect";
import { Base64, Hex } from "effect/encoding";

import type { StoreId } from "../contracts/blob-domain.ts";

import { ClientToken } from "../contracts/blob-domain.ts";

/*
 * Client tokens, as the SDK's `generateClientTokenFromReadWriteToken` builds them:
 * `vercel_blob_client_<storeId>_<base64("<hex HMAC-SHA256(payload)>.<payload>")>`, where `payload` is
 * the base64 of the token's JSON and the HMAC is keyed by the store's read-write token. The JSON is
 * serialized exactly as the SDK does (key order and all), so tokens are byte-identical.
 */

/** Prefix of every client token. */
export const clientTokenPrefix = "vercel_blob_client_";

/** How long a client token generated without `validUntil` stays valid, as the SDK: 30 seconds. */
export const defaultClientTokenLifetimeMillis = 30_000;

/**
 * Fields of a client token's JSON, already in wire form (`validUntil` in epoch milliseconds), in
 * the order they are serialized. `undefined` values are omitted, as `JSON.stringify` omits them.
 */
export type ClientTokenFields = Readonly<Record<string, unknown>>;

/**
 * The JSON a client token encodes, as the SDK serializes it: the fields in their order, with
 * `allowOverwrite: true` appended when `ifMatch` is set and `allowOverwrite` is not, and
 * `validUntil` defaulted to `defaultValidUntil` (kept in place when the fields have it).
 *
 * Callers reject `ifMatch` with `allowOverwrite: false` first; see {@link contradictsIfMatch}.
 */
export const clientTokenPayloadJson = (
  fields: ClientTokenFields,
  defaultValidUntil: number,
): string => {
  const args: Record<string, unknown> = { ...fields };
  if (Boolean(args["ifMatch"]) && args["allowOverwrite"] === undefined) {
    args["allowOverwrite"] = true;
  }
  return JSON.stringify({ ...args, validUntil: args["validUntil"] ?? defaultValidUntil });
};

/** The SDK's message for an `ifMatch` with `allowOverwrite: false`, which it refuses to sign. */
export const ifMatchContradictionMessage =
  "ifMatch and allowOverwrite: false are contradictory. ifMatch is used for conditional overwrites, which requires allowOverwrite to be true.";

/** Whether the fields set `ifMatch` together with `allowOverwrite: false`, which the SDK rejects. */
export const contradictsIfMatch = (fields: ClientTokenFields): boolean =>
  Boolean(fields["ifMatch"]) && fields["allowOverwrite"] === false;

const textEncoder = new TextEncoder();

/** HMAC-SHA256 of `data` keyed by `secret` (both UTF-8), as lowercase hex. */
export const hmacSha256Hex = Effect.fnUntraced(function* (secret: string, data: string) {
  const key = yield* Effect.promise(() =>
    globalThis.crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );
  const signature = yield* Effect.promise(() =>
    globalThis.crypto.subtle.sign("HMAC", key, textEncoder.encode(data)),
  );
  return Hex.encode(new Uint8Array(signature));
});

/**
 * Sign a client token's JSON with the store's read-write token.
 *
 * @param payloadJson - The token's JSON, from {@link clientTokenPayloadJson}.
 * @returns `vercel_blob_client_<storeId>_<base64("<hex HMAC>.<base64 payloadJson>")>`.
 */
export const signClientToken = Effect.fnUntraced(function* (
  readWriteToken: string,
  storeId: StoreId,
  payloadJson: string,
) {
  const payload = Base64.encode(payloadJson);
  const signature = yield* hmacSha256Hex(readWriteToken, payload);
  return ClientToken.make(
    `${clientTokenPrefix}${storeId}_${Base64.encode(`${signature}.${payload}`)}`,
  );
});

/** `onUploadCompleted` as a client token carries it. */
export const ClientTokenCallback = Schema.Struct({
  callbackUrl: Schema.String,
  tokenPayload: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** The JSON a client token encodes, as the SDK's `DecodedClientTokenPayload`. */
export const ClientTokenPayload = Schema.Struct({
  pathname: Schema.String,
  /** Expiry in epoch milliseconds. */
  validUntil: Schema.Number,
  onUploadCompleted: Schema.optionalKey(ClientTokenCallback),
  maximumSizeInBytes: Schema.optionalKey(Schema.Number),
  allowedContentTypes: Schema.optionalKey(Schema.Array(Schema.String)),
  addRandomSuffix: Schema.optionalKey(Schema.Boolean),
  allowOverwrite: Schema.optionalKey(Schema.Boolean),
  cacheControlMaxAge: Schema.optionalKey(Schema.Number),
  ifMatch: Schema.optionalKey(Schema.String),
  /** Set by upload routes, which copy the route's `tokenPayload` into the token as the SDK does. */
  tokenPayload: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** The JSON a client token encodes. */
export type ClientTokenPayload = typeof ClientTokenPayload.Type;

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(ClientTokenPayload));

const decodeBase64String = (input: string): Option.Option<string> =>
  Result.getSuccess(Base64.decodeString(input));

/**
 * Read the JSON a client token encodes without verifying its signature, as the SDK's
 * `getPayloadFromClientToken`: the fifth `_`-separated segment is base64 of `<hmac>.<base64 JSON>`.
 * Works in browsers.
 *
 * @returns None when the token does not have that shape or its JSON is not a client token payload.
 */
export const getPayloadFromClientToken = (clientToken: string): Option.Option<ClientTokenPayload> =>
  decodeBase64String(clientToken.split("_")[4] ?? "").pipe(
    Option.flatMap((secured) => Option.fromUndefinedOr(secured.split(".")[1])),
    Option.flatMap(decodeBase64String),
    Option.flatMap(decodePayload),
  );
