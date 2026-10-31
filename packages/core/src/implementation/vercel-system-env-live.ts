import { Config, Effect, Layer, Option } from "effect";

import { DeploymentId, ProjectId, VercelRegion, VercelTarget } from "../contracts/vercel-domain.ts";
import { VercelSystemEnv } from "../contracts/vercel-system-env.ts";

/**
 * Reads `VercelSystemEnv` from the current `ConfigProvider` once, when the layer is built.
 *
 * Missing variables become `Option.none()`; a present but invalid value (for example a malformed
 * `VERCEL_REGION` or an unknown `VERCEL_ENV`) fails the layer with a `ConfigError`.
 */
export const VercelSystemEnvLive = Layer.effect(
  VercelSystemEnv,
  Effect.gen(function* () {
    const env = yield* Config.all({
      region: Config.option(Config.schema(VercelRegion, "VERCEL_REGION")),
      deploymentId: Config.option(Config.schema(DeploymentId, "VERCEL_DEPLOYMENT_ID")),
      projectId: Config.option(Config.schema(ProjectId, "VERCEL_PROJECT_ID")),
      target: Config.option(Config.schema(VercelTarget, "VERCEL_ENV")),
      url: Config.option(Config.String("VERCEL_URL")),
      branchUrl: Config.option(Config.String("VERCEL_BRANCH_URL")),
      projectProductionUrl: Config.option(Config.String("VERCEL_PROJECT_PRODUCTION_URL")),
      vercel: Config.option(Config.String("VERCEL")),
      nodeEnv: Config.option(Config.String("NODE_ENV")),
      cliVersion: Config.option(Config.String("VERCEL_CLI_VERSION")),
    });
    return VercelSystemEnv.of({
      region: env.region,
      deploymentId: env.deploymentId,
      projectId: env.projectId,
      target: env.target,
      url: env.url,
      branchUrl: env.branchUrl,
      projectProductionUrl: env.projectProductionUrl,
      isVercel: Option.contains(env.vercel, "1"),
      isDevelopment: Option.contains(env.nodeEnv, "development"),
      cliVersion: env.cliVersion,
    });
  }),
);
