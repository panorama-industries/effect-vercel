import type { DeploymentId } from "@panorama-industries/effect-vercel-core";

import { VercelRegion, VercelSystemEnv } from "@panorama-industries/effect-vercel-core";
import { Config, ConfigProvider, Effect, Layer, Option, Redacted, Schema } from "effect";

import { QueueAuth, QueueConfig } from "../contracts/queue-config.ts";

/** Values that replace what {@link QueueConfigLive} derives from the environment. */
export interface QueueConfigOptions {
  /** Default region; otherwise `VERCEL_REGION`, then `iad1`. */
  readonly region?: VercelRegion;

  /** Base URL per region; replaces both the regional default and the local broker URL. */
  readonly baseUrl?: (region: VercelRegion) => URL;

  /** Fixed bearer token used instead of OIDC or the local broker token. */
  readonly token?: string | Redacted.Redacted<string>;

  /**
   * Deployment that sends are pinned to and consumer calls name; otherwise `VERCEL_DEPLOYMENT_ID`.
   * `"unpinned"` sends no deployment at all, so any deployment's consumers may receive messages.
   */
  readonly deploymentId?: DeploymentId | "unpinned";

  /** Extra headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
}

const defaultRegion = VercelRegion.make("iad1");

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

const supportsLocalQueueBroker = (version: string): boolean => {
  if (version.length > 256) return false;
  const match = semver.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4];
  if (
    ![major, minor, patch].every(Number.isSafeInteger) ||
    prerelease?.split(".").some((part) => /^0\d+$/.test(part))
  ) {
    return false;
  }
  return (
    major > 59 ||
    (major === 59 && (minor > 26 || (minor === 26 && (patch > 0 || prerelease === undefined))))
  );
};

const configError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

const nonEmpty = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value) => value !== "")));

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString);

const regionalBaseUrl = (region: VercelRegion) => new URL(`https://${region}.vercel-queue.com`);

const stripTrailingSlashes = (path: string) => path.replace(/\/+$/, "");

const sameEndpoint = (a: URL, b: URL) =>
  a.origin === b.origin && stripTrailingSlashes(a.pathname) === stripTrailingSlashes(b.pathname);

const missingDeploymentId = configError(
  "No deployment ID available. VERCEL_DEPLOYMENT_ID is not set.\n\n" +
    "This usually means the code is running outside a Vercel deployment " +
    "(e.g. during build or in a non-Vercel environment).\n\n" +
    "To fix this, provide an explicit deployment ID:\n" +
    '  queueConfigLayer({ deploymentId: DeploymentId.make("dpl_xxx") })\n' +
    "Or explicitly opt out of deployment pinning:\n" +
    '  queueConfigLayer({ deploymentId: "unpinned" })',
);

const missingLocalToken = configError(
  "Missing local queue token. VERCEL_QUEUE_BASE_URL selects a local broker, " +
    "but VERCEL_QUEUE_TOKEN is not set. Start your app with a Vercel CLI " +
    "version that supports local Queues, or provide an explicit token.",
);

const localToken = Config.option(Config.Redacted("VERCEL_QUEUE_TOKEN")).pipe(
  Effect.map(Option.filter((token) => Redacted.value(token) !== "")),
  Effect.flatMap(
    Option.match({ onNone: () => Effect.fail(missingLocalToken), onSome: Effect.succeed }),
  ),
);

const invalidLocalUrl = configError("Invalid VERCEL_QUEUE_BASE_URL: expected an absolute URL");

const resolveQueueConfig = Effect.fnUntraced(function* (options: QueueConfigOptions) {
  const env = yield* VercelSystemEnv;
  const devMode = env.isDevelopment && Option.isNone(env.deploymentId);

  const region =
    options.region ??
    Option.getOrUndefined(env.region) ??
    (yield* Effect.as(
      devMode
        ? Effect.void
        : Effect.logWarning(
            `Queue region not detected; defaulting to "${defaultRegion}". On Vercel it comes ` +
              "from VERCEL_REGION. Set it explicitly with queueConfigLayer({ region }) to " +
              "silence this warning.",
          ),
      defaultRegion,
    ));

  const injectedUrl =
    devMode && Option.exists(env.cliVersion, supportsLocalQueueBroker)
      ? yield* nonEmpty("VERCEL_QUEUE_BASE_URL")
      : Option.none<string>();
  const localUrl = Option.flatMap(injectedUrl, decodeUrl);
  if (Option.isSome(injectedUrl) && Option.isNone(localUrl) && options.baseUrl === undefined) {
    return yield* Effect.fail(invalidLocalUrl);
  }

  const baseUrl =
    options.baseUrl ??
    Option.match(localUrl, {
      onNone: () => regionalBaseUrl,
      onSome: (url) => () => new URL(url),
    });
  const usesLocalBroker = Option.exists(localUrl, (url) => sameEndpoint(baseUrl(region), url));

  const auth =
    options.token !== undefined
      ? QueueAuth.Token({
          token: Redacted.isRedacted(options.token) ? options.token : Redacted.make(options.token),
        })
      : usesLocalBroker
        ? QueueAuth.Token({ token: yield* localToken })
        : QueueAuth.Oidc();

  const deploymentId =
    options.deploymentId === "unpinned" || usesLocalBroker || devMode
      ? Option.none<DeploymentId>()
      : Option.some(
          yield* Option.match(
            Option.orElse(Option.fromUndefinedOr(options.deploymentId), () => env.deploymentId),
            { onNone: () => Effect.fail(missingDeploymentId), onSome: Effect.succeed },
          ),
        );

  return QueueConfig.of({
    region,
    baseUrl,
    auth,
    deploymentId,
    pinSends: Option.isSome(deploymentId),
    headers: options.headers ?? {},
  });
});

/**
 * Builds {@link QueueConfig} from the environment, with any given values taking precedence.
 *
 * Outside development, construction fails with a `ConfigError` when no deployment ID is known and
 * the options do not opt out with `deploymentId: "unpinned"`.
 */
export const queueConfigLayer = (
  options: QueueConfigOptions = {},
): Layer.Layer<QueueConfig, Config.ConfigError, VercelSystemEnv> =>
  Layer.effect(QueueConfig, resolveQueueConfig(options));

/**
 * Derives {@link QueueConfig} from `VercelSystemEnv`, `VERCEL_QUEUE_BASE_URL` and
 * `VERCEL_QUEUE_TOKEN`.
 *
 * On Vercel it targets `https://{region}.vercel-queue.com` with OIDC and pins sends to the
 * deployment, failing with a `ConfigError` when `VERCEL_DEPLOYMENT_ID` is missing. Under
 * `vercel dev` (CLI 59.26.0 or later) it targets the local broker with its token.
 */
export const QueueConfigLive: Layer.Layer<QueueConfig, Config.ConfigError, VercelSystemEnv> =
  queueConfigLayer();
