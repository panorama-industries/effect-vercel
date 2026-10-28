import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";

import { OidcTokenUnavailable, VercelOidc } from "../contracts/vercel-oidc.ts";
import {
  missingTokenMessage,
  optionalEnv,
  requestOidcToken,
} from "../internal/oidc-token-sources.ts";

/**
 * Reads the OIDC token Vercel supplies to functions, on every evaluation: the
 * `x-vercel-oidc-token` header of the current request, else the `VERCEL_OIDC_TOKEN` variable from
 * the `ConfigProvider` in place when the layer was built.
 *
 * Never refreshes and touches no file system, so it is safe on the Edge runtime. Fails with
 * `OidcTokenUnavailable` when neither source has a token.
 */
export const VercelOidcLive = Layer.effect(
  VercelOidc,
  Effect.gen(function* () {
    const provider = yield* ConfigProvider.ConfigProvider;
    const token = Effect.suspend(() =>
      Option.match(requestOidcToken(), {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.flatMap(optionalEnv(provider, "VERCEL_OIDC_TOKEN"), (token) =>
            Option.match(token, {
              onSome: Effect.succeed,
              onNone: () => Effect.fail(new OidcTokenUnavailable({ message: missingTokenMessage })),
            }),
          ),
      }),
    );
    return VercelOidc.of({ token: Effect.map(token, (token) => Redacted.make(token)) });
  }),
);

/** Supplies a fixed OIDC token, for scripts that already hold one and for tests. */
export const vercelOidcFromToken = (token: Redacted.Redacted<string>): Layer.Layer<VercelOidc> =>
  Layer.succeed(VercelOidc, VercelOidc.of({ token: Effect.succeed(token) }));
