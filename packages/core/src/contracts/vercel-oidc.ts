import type { Effect, Redacted } from "effect";

import { Context, Schema } from "effect";

/** No Vercel OIDC token could be obtained for the current request or process. */
export class OidcTokenUnavailable extends Schema.TaggedError<OidcTokenUnavailable>()(
  "OidcTokenUnavailable",
  {
    /** What was tried and how to fix it, e.g. run `vercel env pull` in local development. */
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Supplies the Vercel OIDC token that authenticates calls to Vercel services from a function.
 */
export class VercelOidc extends Context.Service<
  VercelOidc,
  {
    /**
     * The token for the current request.
     *
     * Evaluate it for every outbound call instead of caching the result: on Vercel the token
     * arrives per request, and in local development it is refreshed when it nears expiry.
     */
    readonly token: Effect.Effect<Redacted.Redacted<string>, OidcTokenUnavailable>;
  }
>()("@effect-vercel/core/VercelOidc") {}
