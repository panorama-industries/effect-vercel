import { assert, describe, it } from "@effect/vitest";
import {
  DeploymentId,
  VercelRegion,
  VercelSystemEnv,
} from "@panorama-industries/effect-vercel-core";
import { ConfigProvider, Effect, Layer, Logger, Option, Redacted } from "effect";

import type { QueueConfigOptions } from "./queue-config-live.ts";

import { QueueAuth, QueueConfig } from "../contracts/queue-config.ts";
import { QueueConfigLive, queueConfigLayer } from "./queue-config-live.ts";

type SystemEnv = VercelSystemEnv["Service"];

const production: SystemEnv = {
  region: Option.some(VercelRegion.make("sfo1")),
  deploymentId: Option.some(DeploymentId.make("dpl_env")),
  projectId: Option.none(),
  target: Option.some("production"),
  url: Option.none(),
  branchUrl: Option.none(),
  projectProductionUrl: Option.none(),
  isVercel: true,
  isDevelopment: false,
  cliVersion: Option.none(),
};

const development: SystemEnv = {
  ...production,
  region: Option.none(),
  deploymentId: Option.none(),
  target: Option.some("development"),
  isVercel: false,
  isDevelopment: true,
  cliVersion: Option.some("59.26.0"),
};

const brokerVars = { VERCEL_QUEUE_BASE_URL: "http://localhost:4100", VERCEL_QUEUE_TOKEN: "local" };

const build = (env: SystemEnv, vars: Record<string, string> = {}, options?: QueueConfigOptions) =>
  Effect.service(QueueConfig).pipe(
    Effect.provide(
      (options === undefined ? QueueConfigLive : queueConfigLayer(options)).pipe(
        Layer.provide(Layer.succeed(VercelSystemEnv, VercelSystemEnv.of(env))),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars))),
      ),
    ),
  );

const recordWarnings = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    const recorder = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    const value = yield* effect.pipe(Effect.provide(Logger.layer([recorder])));
    return { value, warnings };
  });

const tokenOf = (auth: QueueAuth) =>
  QueueAuth.$match(auth, {
    Oidc: () => Option.none<string>(),
    Token: ({ token }) => Option.some(Redacted.value(token)),
  });

const usesLocalBroker = (cliVersion: string) =>
  build({ ...development, cliVersion: Option.some(cliVersion) }, brokerVars).pipe(
    Effect.map((config) => config.baseUrl(VercelRegion.make("iad1")).host === "localhost:4100"),
  );

describe("QueueConfigLive", () => {
  it.effect("targets the regional endpoint with OIDC and pins sends on Vercel", () =>
    Effect.gen(function* () {
      const { value: config, warnings } = yield* recordWarnings(build(production, brokerVars));
      assert.strictEqual(config.region, "sfo1");
      assert.strictEqual(config.baseUrl(config.region).href, "https://sfo1.vercel-queue.com/");
      assert.strictEqual(
        config.baseUrl(VercelRegion.make("fra1")).href,
        "https://fra1.vercel-queue.com/",
      );
      assert.isTrue(QueueAuth.$is("Oidc")(config.auth));
      assert.deepStrictEqual(config.deploymentId, Option.some(DeploymentId.make("dpl_env")));
      assert.isTrue(config.pinSends);
      assert.deepStrictEqual(config.headers, {});
      assert.deepStrictEqual(warnings, []);
    }),
  );

  it.effect("falls back to iad1 with one warning when the region is unknown", () =>
    Effect.gen(function* () {
      const { value: config, warnings } = yield* recordWarnings(
        build({ ...production, region: Option.none() }),
      );
      assert.strictEqual(config.region, "iad1");
      assert.strictEqual(config.baseUrl(config.region).href, "https://iad1.vercel-queue.com/");
      assert.strictEqual(warnings.length, 1);
    }),
  );

  it.effect("falls back to iad1 silently in development", () =>
    Effect.gen(function* () {
      const { value: config, warnings } = yield* recordWarnings(build(development));
      assert.strictEqual(config.region, "iad1");
      assert.deepStrictEqual(warnings, []);
    }),
  );

  it.effect("fails with guidance when no deployment ID is known outside development", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(build({ ...production, deploymentId: Option.none() }));
      assert.strictEqual(error._tag, "ConfigError");
      assert.include(error.message, "VERCEL_DEPLOYMENT_ID is not set");
      assert.include(error.message, 'deploymentId: "unpinned"');
    }),
  );

  it.effect("treats NODE_ENV=development with a deployment ID as a deployment", () =>
    Effect.gen(function* () {
      const config = yield* build(
        { ...development, deploymentId: Option.some(DeploymentId.make("dpl_env")) },
        brokerVars,
      );
      assert.strictEqual(config.baseUrl(config.region).href, "https://iad1.vercel-queue.com/");
      assert.isTrue(QueueAuth.$is("Oidc")(config.auth));
      assert.deepStrictEqual(config.deploymentId, Option.some(DeploymentId.make("dpl_env")));
      assert.isTrue(config.pinSends);
    }),
  );

  it.effect("needs no deployment ID in development and sends none", () =>
    Effect.gen(function* () {
      const config = yield* build({ ...development, cliVersion: Option.none() }, brokerVars);
      assert.strictEqual(config.baseUrl(config.region).href, "https://iad1.vercel-queue.com/");
      assert.isTrue(QueueAuth.$is("Oidc")(config.auth));
      assert.deepStrictEqual(config.deploymentId, Option.none());
      assert.isFalse(config.pinSends);
    }),
  );

  it.effect("uses the local broker and its token under a supporting CLI", () =>
    Effect.gen(function* () {
      const config = yield* build(
        { ...development, region: Option.some(VercelRegion.make("cdg1")) },
        { VERCEL_QUEUE_BASE_URL: "http://localhost:4100/queues", VERCEL_QUEUE_TOKEN: "local" },
      );
      assert.strictEqual(config.region, "cdg1");
      assert.strictEqual(config.baseUrl(config.region).href, "http://localhost:4100/queues");
      assert.strictEqual(
        config.baseUrl(VercelRegion.make("syd1")).href,
        "http://localhost:4100/queues",
      );
      assert.deepStrictEqual(tokenOf(config.auth), Option.some("local"));
      assert.deepStrictEqual(config.deploymentId, Option.none());
      assert.isFalse(config.pinSends);
    }),
  );

  it.effect("detects local broker support from the CLI version like the SDK", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, boolean]> = [
        ["59.26.0", true],
        ["59.26.1", true],
        ["59.27.0", true],
        ["60.0.0", true],
        ["100.1.2", true],
        ["59.26.0+build.7", true],
        ["59.26.1-canary.0", true],
        ["59.27.0-0", true],
        ["60.0.0-beta.1", true],
        ["59.26.0-beta.1", false],
        ["59.26.0-0", false],
        ["59.25.99", false],
        ["58.999.999", false],
        ["59.26.1-01", false],
        ["59.26.1-beta.01", false],
        ["59.26.1-0", true],
        ["059.26.0", false],
        ["v59.26.0", false],
        ["59.26", false],
        ["59.26.0 ", false],
        ["59.26.0-", false],
        ["99999999999999999999.0.0", false],
        [`59.26.0+${"a".repeat(250)}`, false],
        ["", false],
      ];
      for (const [version, expected] of cases) {
        assert.strictEqual(yield* usesLocalBroker(version), expected, version);
      }
    }),
  );

  it.effect("ignores the broker URL outside development or when it is empty", () =>
    Effect.gen(function* () {
      const notDevelopment = yield* build(
        { ...development, isDevelopment: false, deploymentId: Option.some(DeploymentId.make("d")) },
        brokerVars,
      );
      assert.strictEqual(
        notDevelopment.baseUrl(notDevelopment.region).host,
        "iad1.vercel-queue.com",
      );

      const empty = yield* build(development, { VERCEL_QUEUE_BASE_URL: "" });
      assert.strictEqual(empty.baseUrl(empty.region).host, "iad1.vercel-queue.com");
      assert.isTrue(QueueAuth.$is("Oidc")(empty.auth));
    }),
  );

  it.effect("fails on an invalid broker URL", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(build(development, { VERCEL_QUEUE_BASE_URL: "localhost" }));
      assert.strictEqual(error._tag, "ConfigError");
      assert.include(error.message, "Invalid VERCEL_QUEUE_BASE_URL");
    }),
  );

  it.effect("fails when the local broker has no token", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        build(development, { VERCEL_QUEUE_BASE_URL: "http://localhost:4100" }),
      );
      assert.strictEqual(missing._tag, "ConfigError");
      assert.include(missing.message, "Missing local queue token");

      const empty = yield* Effect.flip(
        build(development, {
          VERCEL_QUEUE_BASE_URL: "http://localhost:4100",
          VERCEL_QUEUE_TOKEN: "",
        }),
      );
      assert.include(empty.message, "Missing local queue token");
    }),
  );
});

describe("queueConfigLayer", () => {
  it.effect("overrides region, base URL, token and headers", () =>
    Effect.gen(function* () {
      const config = yield* build(
        production,
        {},
        {
          region: VercelRegion.make("lhr1"),
          baseUrl: (region: VercelRegion) => new URL(`https://queue.example.com/${region}/`),
          token: "explicit",
          headers: { "x-team": "core" },
        },
      );
      assert.strictEqual(config.region, "lhr1");
      assert.strictEqual(config.baseUrl(config.region).href, "https://queue.example.com/lhr1/");
      assert.deepStrictEqual(tokenOf(config.auth), Option.some("explicit"));
      assert.deepStrictEqual(config.headers, { "x-team": "core" });
      assert.deepStrictEqual(config.deploymentId, Option.some(DeploymentId.make("dpl_env")));
    }),
  );

  it.effect("accepts a redacted token", () =>
    Effect.gen(function* () {
      const config = yield* build(production, {}, { token: Redacted.make("secret") });
      assert.deepStrictEqual(tokenOf(config.auth), Option.some("secret"));
    }),
  );

  it.effect("pins to an explicit deployment ID when the environment has none", () =>
    Effect.gen(function* () {
      const config = yield* build(
        { ...production, deploymentId: Option.none() },
        {},
        {
          deploymentId: DeploymentId.make("dpl_explicit"),
        },
      );
      assert.deepStrictEqual(config.deploymentId, Option.some(DeploymentId.make("dpl_explicit")));
      assert.isTrue(config.pinSends);
    }),
  );

  it.effect("prefers an explicit deployment ID over the environment", () =>
    Effect.gen(function* () {
      const config = yield* build(
        production,
        {},
        {
          deploymentId: DeploymentId.make("dpl_explicit"),
        },
      );
      assert.deepStrictEqual(config.deploymentId, Option.some(DeploymentId.make("dpl_explicit")));
    }),
  );

  it.effect("sends no deployment ID at all when unpinned", () =>
    Effect.gen(function* () {
      const withoutEnv = yield* build(
        { ...production, deploymentId: Option.none() },
        {},
        {
          deploymentId: "unpinned",
        },
      );
      assert.deepStrictEqual(withoutEnv.deploymentId, Option.none());
      assert.isFalse(withoutEnv.pinSends);

      const withEnv = yield* build(production, {}, { deploymentId: "unpinned" });
      assert.deepStrictEqual(withEnv.deploymentId, Option.none());
      assert.isFalse(withEnv.pinSends);
    }),
  );

  it.effect("drops an explicit deployment ID in development, like the SDK", () =>
    Effect.gen(function* () {
      const config = yield* build(
        { ...development, cliVersion: Option.none() },
        {},
        {
          deploymentId: DeploymentId.make("dpl_explicit"),
        },
      );
      assert.deepStrictEqual(config.deploymentId, Option.none());
    }),
  );

  it.effect("an explicit token replaces the missing local broker token", () =>
    Effect.gen(function* () {
      const config = yield* build(
        development,
        { VERCEL_QUEUE_BASE_URL: "http://localhost:4100" },
        { token: "explicit" },
      );
      assert.strictEqual(config.baseUrl(config.region).host, "localhost:4100");
      assert.deepStrictEqual(tokenOf(config.auth), Option.some("explicit"));
    }),
  );

  it.effect("a base URL resolver tolerates an invalid broker URL and leaves the broker", () =>
    Effect.gen(function* () {
      const config = yield* build(
        development,
        { VERCEL_QUEUE_BASE_URL: "localhost" },
        {
          baseUrl: () => new URL("https://queue.example.com"),
        },
      );
      assert.strictEqual(config.baseUrl(config.region).href, "https://queue.example.com/");
      assert.isTrue(QueueAuth.$is("Oidc")(config.auth));
    }),
  );

  it.effect("a base URL resolver away from the broker uses OIDC, not the broker token", () =>
    Effect.gen(function* () {
      const config = yield* build(development, brokerVars, {
        baseUrl: (region: VercelRegion) => new URL(`https://${region}.example.com`),
      });
      assert.isTrue(QueueAuth.$is("Oidc")(config.auth));
    }),
  );

  it.effect("a base URL resolver onto the broker keeps the broker token", () =>
    Effect.gen(function* () {
      const config = yield* build(
        development,
        { VERCEL_QUEUE_BASE_URL: "http://localhost:4100/queues", VERCEL_QUEUE_TOKEN: "local" },
        { baseUrl: () => new URL("http://localhost:4100/queues//") },
      );
      assert.deepStrictEqual(tokenOf(config.auth), Option.some("local"));
      assert.deepStrictEqual(config.deploymentId, Option.none());
    }),
  );
});
