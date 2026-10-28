import { Effect, Option, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

import { OidcTokenUnavailable } from "../contracts/vercel-oidc.ts";

const Claims = Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite }));

const decodeClaims = Schema.decodeUnknownOption(Claims);

export const tokenExpiry = (token: string): Effect.Effect<number, OidcTokenUnavailable> => {
  const parts = token.split(".");
  const payload = parts.length === 3 ? parts[1] : undefined;
  return Option.fromNullishOr(payload).pipe(
    Option.flatMap((payload) => Result.getSuccess(Base64Url.decodeString(payload))),
    Option.flatMap(decodeClaims),
    Option.map((claims) => claims.exp * 1000),
    Option.match({
      onNone: () =>
        Effect.fail(
          new OidcTokenUnavailable({
            message: "Invalid token: the Vercel OIDC token is not a JWT with an `exp` claim.",
          }),
        ),
      onSome: Effect.succeed,
    }),
  );
};

export const isExpired = (expiresAtMillis: number, nowMillis: number, bufferMillis: number) =>
  expiresAtMillis < nowMillis + bufferMillis;
