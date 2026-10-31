import type { Option } from "effect";

import { Context } from "effect";

import type { DeploymentId, ProjectId, VercelTarget, VercelRegion } from "./vercel-domain.ts";

/**
 * Deployment facts Vercel exposes through system environment variables.
 *
 * Values are read once when the layer is built. Every field is optional because the same code runs
 * on Vercel, under `vercel dev`, in CI, and in tests.
 */
export class VercelSystemEnv extends Context.Service<
  VercelSystemEnv,
  {
    /** Region the function runs in (`VERCEL_REGION`). */
    readonly region: Option.Option<VercelRegion>;

    /** Deployment the function belongs to (`VERCEL_DEPLOYMENT_ID`). */
    readonly deploymentId: Option.Option<DeploymentId>;

    /** Project the deployment belongs to (`VERCEL_PROJECT_ID`). */
    readonly projectId: Option.Option<ProjectId>;

    /** Deployment target (`VERCEL_ENV`). */
    readonly target: Option.Option<VercelTarget>;

    /** Deployment host name without a scheme (`VERCEL_URL`). */
    readonly url: Option.Option<string>;

    /** Host name of the Git branch's preview deployment, without a scheme (`VERCEL_BRANCH_URL`). */
    readonly branchUrl: Option.Option<string>;

    /**
     * Host name of the project's production domain, without a scheme
     * (`VERCEL_PROJECT_PRODUCTION_URL`). Vercel also sets it in preview deployments.
     */
    readonly projectProductionUrl: Option.Option<string>;

    /** True when the code runs on Vercel (`VERCEL` is `1`). */
    readonly isVercel: boolean;

    /** True when `NODE_ENV` is `development`, which enables local-development behavior. */
    readonly isDevelopment: boolean;

    /**
     * Version of the Vercel CLI that started the process (`VERCEL_CLI_VERSION`), used to detect
     * features such as the local queue broker.
     */
    readonly cliVersion: Option.Option<string>;
  }
>()("@effect-vercel/core/VercelSystemEnv") {}
