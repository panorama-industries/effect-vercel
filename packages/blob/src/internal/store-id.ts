import { Option, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

import { StoreId } from "../contracts/blob-domain.ts";

const decodeStoreId = Schema.decodeUnknownOption(StoreId);

/**
 * Strip the optional `store_` prefix from a store id. `BLOB_STORE_ID` (as written by
 * `vercel env pull`) and the `storeId` option accept `store_<id>` or `<id>`; the API wants the bare
 * id, case preserved.
 */
export const normalizeStoreId = (storeId: string): string =>
  storeId.startsWith("store_") ? storeId.slice("store_".length) : storeId;

/**
 * Validate a store id given in either form (`store_<id>` or `<id>`).
 *
 * @returns The bare id, or none when it is empty or contains whitespace or `_`.
 */
export const parseStoreId = (storeId: string): Option.Option<StoreId> =>
  decodeStoreId(normalizeStoreId(storeId));

/**
 * The store id embedded in a read-write token (`vercel_blob_rw_<storeId>_<secret>`): the fourth
 * `_`-separated segment, as the SDK's `parseStoreIdFromReadWriteToken`.
 *
 * @returns None when the token has no valid fourth segment.
 */
export const storeIdFromReadWriteToken = (token: string): Option.Option<StoreId> =>
  Option.flatMap(Option.fromUndefinedOr(token.split("_")[3]), decodeStoreId);

/**
 * The store id embedded in a client token (`vercel_blob_client_<storeId>_<payload>`). The SDK reads
 * it with the same fourth-segment rule as read-write tokens.
 */
export const storeIdFromClientToken: (token: string) => Option.Option<StoreId> =
  storeIdFromReadWriteToken;

const DelegationPayload = Schema.fromJsonString(Schema.Struct({ storeId: Schema.NonEmptyString }));

const decodeDelegationPayload = Schema.decodeUnknownOption(DelegationPayload);

/**
 * Read the store id from a delegation token, the public half of a signed token that every presigned
 * URL carries in `vercel-blob-delegation`. The token's payload is the base64url JSON before the first
 * `.`; its `storeId` field is returned without the `store_` prefix.
 *
 * Works in browsers, so a client can address the right store from a presigned payload alone.
 *
 * @returns None when the token has no `.`, its payload is not base64url JSON, or it has no
 *   non-empty `storeId` string that is a valid store id.
 */
export const storeIdFromDelegationToken = (delegationToken: string): Option.Option<StoreId> => {
  const dot = delegationToken.indexOf(".");
  if (dot < 0) {
    return Option.none();
  }
  // The SDK's decoder also accepts standard base64 characters; normalize them to base64url.
  const segment = delegationToken
    .slice(0, dot)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return Result.getSuccess(Base64Url.decodeString(segment)).pipe(
    Option.flatMap(decodeDelegationPayload),
    Option.flatMap((payload) => parseStoreId(payload.storeId)),
  );
};
