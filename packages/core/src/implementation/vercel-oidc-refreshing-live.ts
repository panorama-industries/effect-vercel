import type { Duration as DurationNs } from "effect";

import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { AuthConfig, LocalEnvironment } from "../internal/vercel-cli-config.ts";

import { VercelOidc } from "../contracts/vercel-oidc.ts";
import { responseErrorMessage } from "../http/vercel-api-errors.ts";
import { isExpired, tokenExpiry } from "../internal/oidc-token-claims.ts";
import {
  missingTokenMessage,
  optionalEnv,
  requestOidcToken,
} from "../internal/oidc-token-sources.ts";
import {
  fileFailure,
  globalConfigDirectory,
  isNotFound,
  likelyCredentialStorage,
  readAuthConfig,
  readLocalEnvironment,
  unavailable,
  userDataDirectory,
  writeAuthConfig,
} from "../internal/vercel-cli-config.ts";

/** Where {@link vercelOidcRefreshing} finds the project and how early it refreshes. */
export interface VercelOidcRefreshingOptions {
  /** Project ID (`prj_…`) or slug; defaults to `projectId` in `.vercel/project.json`. */
  readonly project?: string | undefined;

  /** Team ID (`team_…`) or slug; defaults to `orgId` in `.vercel/project.json`. */
  readonly team?: string | undefined;

  /** Treat a token as expired this long before its `exp` claim. Defaults to zero. */
  readonly expirationBuffer?: DurationNs.Input | undefined;

  /** Directory searched upward for the linked `.vercel` folder. Defaults to the process cwd. */
  readonly cwd?: string | undefined;
}

const vercelApiUrl = "https://api.vercel.com";
const vercelIssuerUrl = "https://vercel.com";
const vercelCliClientId = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";
const userAgent = "@panorama-industries/effect-vercel-core";
const malformedToken = "Vercel OIDC token is malformed. Expected a string-valued token property.";

const ProjectToken = Schema.Struct({ token: Schema.String });
const decodeProjectToken = Schema.decodeUnknownOption(ProjectToken);
const decodeProjectTokenJson = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectToken));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const ProjectLink = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.optionalKey(Schema.String),
    orgId: Schema.optionalKey(Schema.String),
  }),
);

const Discovery = Schema.Struct({ token_endpoint: Schema.String });

const TokenSet = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Finite,
  refresh_token: Schema.optionalKey(Schema.String),
});

const OAuthError = Schema.Struct({ error: Schema.Unknown });

const refreshFailed = (cause: unknown) =>
  unavailable("Failed to refresh authentication token.", cause);

/**
 * Supplies the OIDC token like `VercelOidcLive` and, in local development, refreshes it when it is
 * missing or expired, the way `@vercel/oidc` does.
 *
 * Also honors `VERCEL_OIDC_TOKEN_FILE`. A refresh reads the linked project from
 * `.vercel/project.json`, reuses the cached project token from the user data directory while it is
 * valid, and otherwise requests a new one with the Vercel CLI credentials: from `auth.json`
 * (refreshing the CLI's OAuth token when needed) or, when the CLI keeps them in the OS keyring, by
 * running `vercel project token`. Requires `FileSystem`, `Path`, `HttpClient` and
 * `ChildProcessSpawner`; every failure is reported as `OidcTokenUnavailable`.
 */
export const vercelOidcRefreshing = (options: VercelOidcRefreshingOptions = {}) =>
  Layer.effect(
    VercelOidc,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const provider = yield* ConfigProvider.ConfigProvider;
      const env: LocalEnvironment = yield* readLocalEnvironment(provider);
      const bufferMillis = Duration.toMillis(
        Duration.fromInputUnsafe(options.expirationBuffer ?? 0),
      );
      const cwd = path.resolve(options.cwd ?? ".");
      const tokenEndpoint = yield* Ref.make(Option.none<string>());
      const refreshed = yield* Ref.make(Option.none<string>());
      const refreshLock = yield* Semaphore.make(1);

      const provide = <A, E>(
        effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
      ): Effect.Effect<A, E> =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );

      const isValid = Effect.fnUntraced(function* (token: string) {
        const expiresAt = yield* tokenExpiry(token);
        const now = yield* Clock.currentTimeMillis;
        return !isExpired(expiresAt, now, bufferMillis);
      });

      const fileToken = Effect.gen(function* () {
        const file = yield* optionalEnv(provider, "VERCEL_OIDC_TOKEN_FILE");
        if (Option.isNone(file)) {
          return Option.none<string>();
        }
        const token = (yield* fs
          .readFileString(file.value)
          .pipe(Effect.mapError(fileFailure("Failed to read the Vercel OIDC token file")))).trim();
        if (token.length === 0) {
          return yield* unavailable(`The Vercel OIDC token file is empty: ${file.value}`);
        }
        return Option.some(token);
      });

      const findRootDir = Effect.gen(function* () {
        let dir = cwd;
        while (dir !== path.dirname(dir)) {
          if (yield* fs.exists(path.join(dir, ".vercel")).pipe(Effect.orElseSucceed(() => false))) {
            return Option.some(dir);
          }
          dir = path.dirname(dir);
        }
        return Option.none<string>();
      });

      const findProjectInfo = Effect.gen(function* () {
        const root = yield* findRootDir;
        if (Option.isNone(root)) {
          return yield* unavailable(
            "Unable to find project root directory. Have you linked your project with `vc link?`",
          );
        }
        const projectFile = path.join(root.value, ".vercel", "project.json");
        const text = yield* fs.readFileString(projectFile).pipe(
          Effect.map(Option.some),
          Effect.catchIf(isNotFound, () => Effect.succeedNone),
          Effect.mapError(fileFailure("Failed to read project.json")),
        );
        if (Option.isNone(text)) {
          return yield* unavailable(
            "project.json not found, have you linked your project with `vc link?`",
          );
        }
        const link = yield* Schema.decodeUnknownEffect(ProjectLink)(text.value).pipe(
          Effect.mapError((error) =>
            unavailable(
              "Expected a string-valued projectId property. Try running `vc link` to re-link your project.",
              error,
            ),
          ),
        );
        if (link.projectId === undefined && link.orgId === undefined) {
          return yield* unavailable(
            "Expected a string-valued projectId property. Try running `vc link` to re-link your project.",
          );
        }
        return link;
      });

      const tokenCachePath = (projectId: string) =>
        Option.match(userDataDirectory(env, path), {
          onNone: () =>
            Effect.fail(
              unavailable(
                "Unable to find user data directory. Please reach out to Vercel support.",
              ),
            ),
          onSome: (dir) => Effect.succeed(path.join(dir, "com.vercel.token", `${projectId}.json`)),
        });

      const loadCachedToken = Effect.fnUntraced(function* (projectId: string) {
        const file = yield* tokenCachePath(projectId);
        const text = yield* fs.readFileString(file).pipe(
          Effect.map(Option.some),
          Effect.catchIf(isNotFound, () => Effect.succeedNone),
          Effect.mapError(fileFailure("Failed to read the cached Vercel OIDC token")),
        );
        if (Option.isNone(text)) {
          return Option.none<string>();
        }
        return yield* Option.match(decodeProjectTokenJson(text.value), {
          onNone: () => Effect.fail(unavailable(malformedToken)),
          onSome: (cached) => Effect.succeed(Option.some(cached.token)),
        });
      });

      const saveCachedToken = Effect.fnUntraced(function* (token: string, projectId: string) {
        const file = yield* tokenCachePath(projectId);
        yield* fs
          .makeDirectory(path.dirname(file), { recursive: true, mode: 0o770 })
          .pipe(
            Effect.andThen(fs.writeFileString(file, JSON.stringify({ token }))),
            Effect.andThen(fs.chmod(file, 0o660)),
            Effect.mapError(fileFailure("Failed to save the Vercel OIDC token")),
          );
      });

      const discoverTokenEndpoint = Effect.gen(function* () {
        const cached = yield* Ref.get(tokenEndpoint);
        if (Option.isSome(cached)) {
          return cached.value;
        }
        const response = yield* httpClient.get(
          `${vercelIssuerUrl}/.well-known/openid-configuration`,
          {
            headers: { "user-agent": userAgent },
          },
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* unavailable("Failed to discover OAuth endpoints");
        }
        const discovery = yield* HttpClientResponse.schemaBodyJson(Discovery)(response).pipe(
          Effect.mapError((error) => unavailable("Invalid OAuth discovery response", error)),
        );
        yield* Ref.set(tokenEndpoint, Option.some(discovery.token_endpoint));
        return discovery.token_endpoint;
      });

      const refreshAccessToken = Effect.fnUntraced(function* (refreshToken: string) {
        const endpoint = yield* discoverTokenEndpoint;
        const response = yield* HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeader("user-agent", userAgent),
          HttpClientRequest.bodyUrlParams({
            client_id: vercelCliClientId,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
          httpClient.execute,
        );
        const json = yield* response.json;
        if (response.status < 200 || response.status >= 300) {
          const error = Schema.decodeUnknownOption(OAuthError)(json).pipe(
            Option.map((body) => String(body.error)),
            Option.getOrElse(() => "Token refresh failed"),
          );
          return yield* unavailable(error);
        }
        return yield* Schema.decodeUnknownEffect(TokenSet)(json).pipe(
          Effect.mapError((error) =>
            unavailable(`Invalid token response: ${error.message}`, error),
          ),
        );
      });

      const cliAccessToken = Effect.fnUntraced(function* (configDir: string) {
        const auth = yield* readAuthConfig(configDir);
        if (
          Option.isNone(auth) ||
          (auth.value.token === undefined && auth.value.refreshToken === undefined)
        ) {
          return yield* unavailable(
            "No authentication found. Please log in with the Vercel CLI (vercel login).",
          );
        }
        const config = auth.value;
        const now = yield* Clock.currentTimeMillis;
        if (
          config.token !== undefined &&
          (config.expiresAt === undefined ||
            config.expiresAt >= Math.floor(now / 1000) + bufferMillis / 1000)
        ) {
          return config.token;
        }
        const clearAuth = Effect.ignore(writeAuthConfig(configDir, {}));
        if (config.refreshToken === undefined) {
          yield* clearAuth;
          return yield* refreshFailed("No refresh token available");
        }
        const tokens = yield* refreshAccessToken(config.refreshToken).pipe(
          Effect.catch((error) => Effect.andThen(clearAuth, Effect.fail(refreshFailed(error)))),
        );
        const refreshedAt = yield* Clock.currentTimeMillis;
        const updated: AuthConfig = {
          token: tokens.access_token,
          expiresAt: Math.floor(refreshedAt / 1000) + tokens.expires_in,
          refreshToken: tokens.refresh_token ?? config.refreshToken,
        };
        yield* writeAuthConfig(configDir, updated);
        return tokens.access_token;
      });

      const projectTokenFromApi = Effect.fnUntraced(function* (
        authToken: string,
        projectId: string,
        teamId: Option.Option<string>,
      ) {
        const response = yield* HttpClientRequest.post(
          `${vercelApiUrl}/v1/projects/${encodeURIComponent(projectId)}/token`,
        ).pipe(
          HttpClientRequest.setUrlParams({
            source: "vercel-oidc-refresh",
            ...Option.match(teamId, { onNone: () => ({}), onSome: (teamId) => ({ teamId }) }),
          }),
          HttpClientRequest.bearerToken(authToken),
          httpClient.execute,
        );
        if (response.status < 200 || response.status >= 300) {
          const message = yield* responseErrorMessage(response);
          return yield* unavailable(`Failed to refresh OIDC token: ${message}`);
        }
        const body = yield* response.json;
        return yield* Option.match(decodeProjectToken(body), {
          onNone: () => Effect.fail(unavailable(`Failed to refresh OIDC token: ${malformedToken}`)),
          onSome: (token) => Effect.succeed(token.token),
        });
      });

      const projectTokenFromCli = Effect.fnUntraced(function* (
        projectId: string,
        teamId: Option.Option<string>,
      ) {
        const cliFailure = (message: string, cause?: unknown) =>
          unavailable(`Failed to refresh OIDC token with the Vercel CLI: ${message}`, cause);
        const args = [
          "project",
          "token",
          projectId,
          "--format=json",
          ...Option.match(teamId, { onNone: () => [], onSome: (teamId) => ["--scope", teamId] }),
        ];
        const { stdout, stderr, exitCode } = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("vercel", args, {
                cwd,
                ...Option.match(env.path, {
                  onNone: () => ({}),
                  onSome: (PATH) => ({ env: { PATH }, extendEnv: true }),
                }),
              }),
            );
            const [stdout, stderr] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
              ],
              { concurrency: 2 },
            );
            const exitCode = yield* handle.exitCode;
            return { stdout, stderr, exitCode };
          }),
        ).pipe(Effect.mapError((error) => cliFailure(error.message, error)));
        if (exitCode !== 0) {
          const details = stderr.trim();
          return yield* cliFailure(
            `Command failed with exit code ${exitCode}${details.length > 0 ? `\n${details}` : ""}`,
          );
        }
        const json = decodeJson(stdout);
        if (Option.isNone(json)) {
          return yield* unavailable(
            `Failed to refresh OIDC token: \`vercel project token\` returned invalid JSON: ${stdout}`,
          );
        }
        return yield* Option.match(decodeProjectToken(json.value), {
          onNone: () => Effect.fail(cliFailure(malformedToken)),
          onSome: (token) => Effect.succeed(token.token),
        });
      });

      const refresh = Effect.gen(function* () {
        let projectId = Option.fromNullishOr(options.project);
        let teamId = Option.fromNullishOr(options.team);
        if (Option.isNone(projectId) || Option.isNone(teamId)) {
          const link = yield* findProjectInfo;
          projectId = Option.orElse(projectId, () => Option.fromNullishOr(link.projectId));
          teamId = Option.orElse(teamId, () => Option.fromNullishOr(link.orgId));
        }
        if (Option.isNone(projectId)) {
          return yield* unavailable(
            "Failed to refresh OIDC token: No project specified. Try re-linking your project with `vc link`",
          );
        }
        const cached = yield* loadCachedToken(projectId.value);
        if (Option.isSome(cached) && (yield* isValid(cached.value))) {
          return cached.value;
        }
        const configDir = yield* provide(globalConfigDirectory(env));
        const storage = yield* provide(likelyCredentialStorage(configDir, env));
        const token =
          storage === "keyring"
            ? yield* projectTokenFromCli(projectId.value, teamId)
            : yield* projectTokenFromApi(
                yield* provide(cliAccessToken(configDir)),
                projectId.value,
                teamId,
              );
        yield* saveCachedToken(token, projectId.value);
        return token;
      }).pipe(
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(unavailable(`Failed to refresh OIDC token: ${error.message}`, error)),
        ),
      );

      const refreshOnce = Effect.gen(function* () {
        const previous = yield* Ref.get(refreshed);
        if (Option.isSome(previous) && (yield* isValid(previous.value))) {
          return previous.value;
        }
        const token = yield* refresh;
        yield* Ref.set(refreshed, Option.some(token));
        return token;
      }).pipe(Semaphore.withPermit(refreshLock));

      const sourceToken = Effect.gen(function* () {
        const fromRequest = requestOidcToken();
        if (Option.isSome(fromRequest)) {
          return fromRequest;
        }
        const fromFile = yield* fileToken;
        if (Option.isSome(fromFile)) {
          return fromFile;
        }
        return yield* optionalEnv(provider, "VERCEL_OIDC_TOKEN");
      });

      const token = Effect.gen(function* () {
        const current = yield* sourceToken;
        if (Option.isSome(current)) {
          if (yield* isValid(current.value)) {
            return current.value;
          }
          return yield* refreshOnce;
        }
        return yield* refreshOnce.pipe(
          Effect.mapError((error) =>
            unavailable(`${missingTokenMessage}\nRefreshing it failed: ${error.message}`, error),
          ),
        );
      });

      return VercelOidc.of({ token: Effect.map(token, (token) => Redacted.make(token)) });
    }),
  );

/** {@link vercelOidcRefreshing} with default options: project and team from `.vercel/project.json`. */
export const VercelOidcRefreshingLive = vercelOidcRefreshing();
