import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer, Option } from "effect";

import { VercelSystemEnv } from "../contracts/vercel-system-env.ts";
import { VercelSystemEnvLive } from "./vercel-system-env-live.ts";

const systemEnv = (env: Record<string, string>) =>
  Effect.gen(function* () {
    return yield* VercelSystemEnv;
  }).pipe(
    Effect.provide(
      VercelSystemEnvLive.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      ),
    ),
  );

describe("VercelSystemEnvLive", () => {
  it.effect("reads every variable Vercel sets", () =>
    Effect.gen(function* () {
      const env = yield* systemEnv({
        VERCEL_REGION: "iad1",
        VERCEL_DEPLOYMENT_ID: "dpl_123",
        VERCEL_PROJECT_ID: "prj_456",
        VERCEL_ENV: "preview",
        VERCEL_URL: "my-app-abc123.vercel.app",
        VERCEL_BRANCH_URL: "my-app-git-main.vercel.app",
        VERCEL_PROJECT_PRODUCTION_URL: "my-app.com",
        VERCEL: "1",
        NODE_ENV: "production",
        VERCEL_CLI_VERSION: "48.1.0",
      });
      assert.deepStrictEqual(env.region, Option.some("iad1" as never));
      assert.deepStrictEqual(env.deploymentId, Option.some("dpl_123" as never));
      assert.deepStrictEqual(env.projectId, Option.some("prj_456" as never));
      assert.deepStrictEqual(env.target, Option.some("preview" as const));
      assert.deepStrictEqual(env.url, Option.some("my-app-abc123.vercel.app"));
      assert.deepStrictEqual(env.branchUrl, Option.some("my-app-git-main.vercel.app"));
      assert.deepStrictEqual(env.projectProductionUrl, Option.some("my-app.com"));
      assert.isTrue(env.isVercel);
      assert.isFalse(env.isDevelopment);
      assert.deepStrictEqual(env.cliVersion, Option.some("48.1.0"));
    }),
  );

  it.effect("treats missing variables as absent", () =>
    Effect.gen(function* () {
      const env = yield* systemEnv({});
      assert.isTrue(Option.isNone(env.region));
      assert.isTrue(Option.isNone(env.deploymentId));
      assert.isTrue(Option.isNone(env.projectId));
      assert.isTrue(Option.isNone(env.target));
      assert.isTrue(Option.isNone(env.url));
      assert.isTrue(Option.isNone(env.branchUrl));
      assert.isTrue(Option.isNone(env.projectProductionUrl));
      assert.isTrue(Option.isNone(env.cliVersion));
      assert.isFalse(env.isVercel);
      assert.isFalse(env.isDevelopment);
    }),
  );

  it.effect("treats empty variables as absent", () =>
    Effect.gen(function* () {
      const env = yield* systemEnv({
        VERCEL_DEPLOYMENT_ID: "",
        VERCEL_URL: "",
        VERCEL_BRANCH_URL: "",
        VERCEL_PROJECT_PRODUCTION_URL: "",
        VERCEL: "",
      });
      assert.isTrue(Option.isNone(env.deploymentId));
      assert.isTrue(Option.isNone(env.url));
      assert.isTrue(Option.isNone(env.branchUrl));
      assert.isTrue(Option.isNone(env.projectProductionUrl));
      assert.isFalse(env.isVercel);
    }),
  );

  it.effect.each(["0", "true", "yes"])("does not treat VERCEL=%s as running on Vercel", (value) =>
    Effect.gen(function* () {
      const env = yield* systemEnv({ VERCEL: value });
      assert.isFalse(env.isVercel);
    }),
  );

  it.effect("detects local development from NODE_ENV", () =>
    Effect.gen(function* () {
      const env = yield* systemEnv({ NODE_ENV: "development" });
      assert.isTrue(env.isDevelopment);
    }),
  );

  it.effect.each([
    { name: "VERCEL_REGION", value: "Not A Region" },
    { name: "VERCEL_ENV", value: "staging" },
    { name: "VERCEL_REGION", value: "iad" },
  ])("fails with a ConfigError for an invalid $name", ({ name, value }) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(systemEnv({ [name]: value }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "ConfigError");
    }),
  );
});
