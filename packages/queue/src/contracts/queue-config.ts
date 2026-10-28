import type { DeploymentId, VercelRegion } from "@panorama-industries/effect-vercel-core";
import type { Option, Redacted } from "effect";

import { Context, Data } from "effect";

/** How the client authenticates to the queue service. */
export type QueueAuth = Data.TaggedEnum<{
  /** Use the Vercel OIDC token of the current request (production and `vercel env pull`). */
  Oidc: {};
  /** Use a fixed bearer token, such as the local broker's `VERCEL_QUEUE_TOKEN`. */
  Token: { readonly token: Redacted.Redacted<string> };
}>;

/** Constructors and matchers for {@link QueueAuth}. */
export const QueueAuth = Data.taggedEnum<QueueAuth>();

/** Where and as whom the queue client talks to Vercel Queues. */
export class QueueConfig extends Context.Service<
  QueueConfig,
  {
    /** Region for sends and receives that do not name one. */
    readonly region: VercelRegion;

    /**
     * Base URL of the queue service in a region; the client appends `/api/v3/...`. The default is
     * `https://{region}.vercel-queue.com`; the local broker ignores the region.
     */
    readonly baseUrl: (region: VercelRegion) => URL;

    readonly auth: QueueAuth;

    /**
     * Deployment sent with consumer calls (receive, acknowledge, change visibility) so the queue
     * routes them to this deployment's consumer registration. None for the local broker.
     */
    readonly deploymentId: Option.Option<DeploymentId>;

    /**
     * Whether sends are pinned to {@link deploymentId}, so only this deployment's consumers receive
     * them. Pinning is the default on Vercel; turning it off lets newer deployments consume.
     */
    readonly pinSends: boolean;

    /** Extra headers sent with every request. */
    readonly headers: Readonly<Record<string, string>>;
  }
>()("@effect-vercel/queue/QueueConfig") {}
