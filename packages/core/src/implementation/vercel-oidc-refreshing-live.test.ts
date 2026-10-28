import type { Scope } from "effect";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import type { TestHttpRequest, TestHttpResponse } from "../testing/test-http-server.ts";
import type { VercelOidcRefreshingOptions } from "./vercel-oidc-refreshing-live.ts";

import { OidcTokenUnavailable, VercelOidc } from "../contracts/vercel-oidc.ts";
import { TestHttpServer, TestHttpServerLive } from "../testing/test-http-server.ts";
import { vercelOidcRefreshing } from "./vercel-oidc-refreshing-live.ts";

const now = Date.parse("2025-06-01T00:00:00Z");
const projectId = "prj_test123";
const teamId = "team_test456";

const jwt = (expiresAtSeconds: number, label = "token") =>
  [
    Base64Url.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    Base64Url.encode(JSON.stringify({ sub: "test-sub", exp: expiresAtSeconds, iat: now / 1000 })),
    `signature-${label}`,
  ].join(".");

const validToken = (label = "valid") => jwt(now / 1000 + 43_200, label);
const expiredToken = (label = "expired") => jwt(1, label);

const json = (body: unknown, status = 200): TestHttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const fakeVercelCli = `#!/bin/sh
dir="$(dirname "$0")"
printf '%s\\n' "$@" > "$dir/args.txt"
cat "$dir/stdout.txt"
cat "$dir/stderr.txt" >&2
exit "$(cat "$dir/exit.txt")"
`;

/** Real HTTP to the test server: every https request is redirected there, keeping its path. */
const RedirectingHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const server = yield* TestHttpServer;
    const client = yield* HttpClient.HttpClient;
    return HttpClient.mapRequest(client, (request) => {
      const url = new URL(request.url);
      return url.protocol === "https:"
        ? request.pipe(
            HttpClientRequest.setUrl(`${server.url}${url.pathname}`),
            HttpClientRequest.setHeader("x-test-origin", url.origin),
          )
        : request;
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* TestHttpServer;
  yield* TestClock.setTime(now);
  const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "vercel-oidc-" });
  const root = path.join(tmp, "project");
  const dataDir = path.join(tmp, "data");
  const cliDir = path.join(dataDir, "com.vercel.cli");
  const tokenDir = path.join(dataDir, "com.vercel.token");
  const binDir = path.join(tmp, "bin");
  for (const dir of [path.join(root, ".vercel"), cliDir, tokenDir, binDir]) {
    yield* fs.makeDirectory(dir, { recursive: true });
  }
  yield* fs.writeFileString(path.join(binDir, "vercel"), fakeVercelCli, { mode: 0o755 });
  const write = (file: string, value: unknown) =>
    fs.writeFileString(file, typeof value === "string" ? value : JSON.stringify(value));
  const read = (file: string) =>
    Effect.map(fs.readFileString(file), (text): unknown => JSON.parse(text));
  const env: Record<string, string> = {
    XDG_DATA_HOME: dataDir,
    HOME: path.join(tmp, "home"),
    PATH: `${binDir}:/usr/bin:/bin`,
  };

  const harness = {
    tmp,
    root,
    cliDir,
    tokenDir,
    env,
    server,
    authFile: path.join(cliDir, "auth.json"),
    projectFile: path.join(root, ".vercel", "project.json"),
    tokenFile: (project = projectId) => path.join(tokenDir, `${project}.json`),
    write,
    read,
    exists: fs.exists,
    cli: (stdout: string, options: { stderr?: string; exitCode?: number } = {}) =>
      Effect.all([
        write(path.join(binDir, "stdout.txt"), stdout),
        write(path.join(binDir, "stderr.txt"), options.stderr ?? ""),
        write(path.join(binDir, "exit.txt"), String(options.exitCode ?? 0)),
      ]),
    cliArgs: Effect.map(fs.readFileString(path.join(binDir, "args.txt")), (text) =>
      text.trim().split("\n"),
    ),
    requests: (pathname: string) =>
      Effect.map(server.requests, (requests) =>
        requests.filter((request) => request.url.split("?")[0] === pathname),
      ),
    /** Evaluates the token through a freshly built layer with the given environment and options. */
    token: (extraEnv: Record<string, string> = {}, options: VercelOidcRefreshingOptions = {}) =>
      Effect.gen(function* () {
        const oidc = yield* VercelOidc;
        return Redacted.value(yield* oidc.token);
      }).pipe(
        Effect.provide(
          vercelOidcRefreshing({ cwd: root, ...options }).pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                RedirectingHttpClient,
                ConfigProvider.layer(ConfigProvider.fromUnknown({ ...env, ...extraEnv })),
              ),
            ),
          ),
        ),
        Effect.provideService(TestHttpServer, server),
      ),
  };
  return harness;
});

type Harness = Effect.Success<typeof setup>;

const tokenEndpointPath = "/api/login/oauth/token";
const projectTokenPath = (project = projectId) => `/v1/projects/${project}/token`;

const vercelApi =
  (
    projectToken: () => TestHttpResponse,
    oauth: (request: TestHttpRequest) => TestHttpResponse = () => json({}, 500),
  ) =>
  (request: TestHttpRequest): TestHttpResponse => {
    const pathname = request.url.split("?")[0] ?? "";
    if (pathname === "/.well-known/openid-configuration") {
      return json({ token_endpoint: `https://vercel.com${tokenEndpointPath}` });
    }
    if (pathname === tokenEndpointPath) {
      return oauth(request);
    }
    if (pathname.startsWith("/v1/projects/")) {
      return projectToken();
    }
    return json({ error: "not found" }, 404);
  };

const issuing = (token: string) => vercelApi(() => json({ token }));

const scenario = <A, E>(
  handler: (request: TestHttpRequest) => TestHttpResponse,
  body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>,
) =>
  Effect.flatMap(setup, body).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(TestHttpServerLive({ handler }), NodeServices.layer)),
  );

const failure = (effect: Effect.Effect<unknown, OidcTokenUnavailable>) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.instanceOf(error, OidcTokenUnavailable);
    return error.message;
  });

describe("vercelOidcRefreshing: token sources", () => {
  it.effect("returns a valid token from the environment without refreshing", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const token = validToken();
        assert.strictEqual(yield* h.token({ VERCEL_OIDC_TOKEN: token }), token);
        assert.strictEqual((yield* h.server.requests).length, 0);
      }),
    ),
  );

  it.effect("does not refresh a valid token even when project and team are given", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const token = validToken();
        const result = yield* h.token(
          { VERCEL_OIDC_TOKEN: token },
          { team: "custom-team", project: "custom-project" },
        );
        assert.strictEqual(result, token);
        assert.strictEqual((yield* h.server.requests).length, 0);
      }),
    ),
  );

  it.effect("reads the token file on each call after rotation", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const file = `${h.tmp}/oidc-token`;
        const env = { VERCEL_OIDC_TOKEN_FILE: file };
        const oidc = h.token(env);
        yield* h.write(file, `${validToken("first")}\n`);
        assert.strictEqual(yield* oidc, validToken("first"));
        yield* h.write(file, `${validToken("second")}\n`);
        assert.strictEqual(yield* oidc, validToken("second"));
      }),
    ),
  );

  it.effect("prefers the token file over the environment token", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const file = `${h.tmp}/oidc-token`;
        yield* h.write(file, validToken("current"));
        const result = yield* h.token(
          { VERCEL_OIDC_TOKEN: validToken("stale"), VERCEL_OIDC_TOKEN_FILE: file },
          { team: teamId, project: projectId, expirationBuffer: "1 minute" },
        );
        assert.strictEqual(result, validToken("current"));
        assert.strictEqual((yield* h.server.requests).length, 0);
      }),
    ),
  );

  it.effect("keeps the request token ahead of the token file", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const key = Symbol.for("@vercel/request-context");
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Reflect.set(globalThis, key, {
              get: () => ({ headers: { "x-vercel-oidc-token": validToken("request") } }),
            }),
          ),
          () => Effect.sync(() => Reflect.deleteProperty(globalThis, key)),
        );
        const result = yield* h.token({ VERCEL_OIDC_TOKEN_FILE: `${h.tmp}/missing-token` });
        assert.strictEqual(result, validToken("request"));
        assert.strictEqual((yield* h.server.requests).length, 0);
      }),
    ),
  );

  it.effect("names the token file when it is empty", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const file = `${h.tmp}/oidc-token`;
        yield* h.write(file, " \n");
        const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN_FILE: file }));
        assert.include(message, `The Vercel OIDC token file is empty: ${file}`);
      }),
    ),
  );

  it.effect("fails on a missing token file instead of using the environment token", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const message = yield* failure(
          h.token({
            VERCEL_OIDC_TOKEN: validToken(),
            VERCEL_OIDC_TOKEN_FILE: `${h.tmp}/missing-token`,
          }),
        );
        assert.include(message, "Failed to read the Vercel OIDC token file");
        assert.include(message, "NotFound");
      }),
    ),
  );

  it.effect("rejects a token that is not a JWT", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: "not-a-valid-jwt-token" }));
        assert.include(message, "Invalid token");
      }),
    ),
  );

  it.effect("explains both the missing token and the failed refresh", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const message = yield* failure(h.token());
        assert.include(message, "x-vercel-oidc-token");
        assert.include(message, "project.json not found");
      }),
    ),
  );
});

describe("vercelOidcRefreshing: refresh through the Vercel API", () => {
  it.effect("refreshes an expired token and caches it in the user data directory", () =>
    scenario(issuing(validToken("new")), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test-auth-token" });
        yield* h.write(h.projectFile, { projectId, orgId: teamId });
        assert.strictEqual(
          yield* h.token({ VERCEL_OIDC_TOKEN: expiredToken() }),
          validToken("new"),
        );
        const [request] = yield* h.requests(projectTokenPath());
        assert.strictEqual(request?.method, "POST");
        assert.strictEqual(
          request?.url,
          `${projectTokenPath()}?source=vercel-oidc-refresh&teamId=${teamId}`,
        );
        assert.strictEqual(request?.headers.authorization, "Bearer test-auth-token");
        assert.strictEqual(request?.headers["x-test-origin"], "https://api.vercel.com");
        assert.deepStrictEqual(yield* h.read(h.tokenFile()), { token: validToken("new") });
      }),
    ),
  );

  it.effect("omits teamId when the project has no team", () =>
    scenario(issuing(validToken("new")), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test" });
        yield* h.write(h.projectFile, { projectId });
        yield* h.token();
        const [request] = yield* h.requests(projectTokenPath());
        assert.strictEqual(request?.url, `${projectTokenPath()}?source=vercel-oidc-refresh`);
      }),
    ),
  );

  it.effect("reuses the cached project token without calling the API", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.projectFile, { projectId });
        yield* h.write(h.tokenFile(), { token: validToken("saved") });
        assert.strictEqual(yield* h.token(), validToken("saved"));
        assert.strictEqual((yield* h.server.requests).length, 0);
      }),
    ),
  );

  it.effect("uses the given project and team without reading project.json", () =>
    scenario(issuing(validToken("custom")), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test" });
        const result = yield* h.token(
          { VERCEL_OIDC_TOKEN: expiredToken() },
          { project: "prj_custom123", team: "team_custom456" },
        );
        assert.strictEqual(result, validToken("custom"));
        const [request] = yield* h.requests(projectTokenPath("prj_custom123"));
        assert.strictEqual(
          request?.url,
          `${projectTokenPath("prj_custom123")}?source=vercel-oidc-refresh&teamId=team_custom456`,
        );
        assert.deepStrictEqual(yield* h.read(h.tokenFile("prj_custom123")), {
          token: validToken("custom"),
        });
      }),
    ),
  );

  it.effect("takes the team from project.json when only the project is given", () =>
    scenario(issuing(validToken()), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test" });
        yield* h.write(h.projectFile, { projectId: "original-project-id", orgId: teamId });
        yield* h.token({}, { project: "prj_custom234" });
        const [request] = yield* h.requests(projectTokenPath("prj_custom234"));
        assert.include(request?.url, `teamId=${teamId}`);
      }),
    ),
  );

  it.effect("takes the project from project.json when only the team is given", () =>
    scenario(issuing(validToken()), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test" });
        yield* h.write(h.projectFile, { projectId, orgId: "original-team-id" });
        yield* h.token({}, { team: "team_custom789" });
        const [request] = yield* h.requests(projectTokenPath(projectId));
        assert.include(request?.url, "teamId=team_custom789");
      }),
    ),
  );

  it.effect("uses a cached token for a custom project while it is valid", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.tokenFile("prj_customcached123"), { token: validToken("cached") });
        const result = yield* h.token({}, { project: "prj_customcached123", team: "team_x" });
        assert.strictEqual(result, validToken("cached"));
        assert.strictEqual((yield* h.server.requests).length, 0);
      }),
    ),
  );

  it.effect("refreshes a cached token that expires within the buffer", () =>
    scenario(issuing(validToken("fresh")), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test" });
        yield* h.write(h.tokenFile(), { token: jwt(now / 1000 + 180, "soon") });
        const result = yield* h.token(
          {},
          { project: projectId, team: teamId, expirationBuffer: "5 minutes" },
        );
        assert.strictEqual(result, validToken("fresh"));
        assert.deepStrictEqual(yield* h.read(h.tokenFile()), { token: validToken("fresh") });
      }),
    ),
  );

  it.effect("keeps a cached token that outlives the buffer", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.tokenFile(), { token: jwt(now / 1000 + 600, "later") });
        const result = yield* h.token(
          {},
          { project: projectId, team: teamId, expirationBuffer: "5 minutes" },
        );
        assert.strictEqual(result, jwt(now / 1000 + 600, "later"));
        assert.strictEqual((yield* h.server.requests).length, 0);
      }),
    ),
  );

  it.effect("refreshes a token file that expires within the buffer", () =>
    scenario(issuing(validToken("refreshed")), (h) =>
      Effect.gen(function* () {
        const file = `${h.tmp}/oidc-token`;
        yield* h.write(file, jwt(now / 1000 + 30, "near-expiry"));
        yield* h.write(h.authFile, { token: "test-auth-token" });
        const result = yield* h.token(
          { VERCEL_OIDC_TOKEN_FILE: file },
          { team: teamId, project: projectId, expirationBuffer: "1 minute" },
        );
        assert.strictEqual(result, validToken("refreshed"));
      }),
    ),
  );

  it.effect("reports an API failure", () =>
    scenario(
      vercelApi(() => json({ error: { code: "forbidden", message: "Not authorized" } }, 403)),
      (h) =>
        Effect.gen(function* () {
          yield* h.write(h.authFile, { token: "test" });
          yield* h.write(h.projectFile, { projectId, orgId: teamId });
          const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: expiredToken() }));
          assert.include(message, "Failed to refresh OIDC token: Not authorized");
        }),
    ),
  );

  it.effect("reports a malformed API response", () =>
    scenario(
      vercelApi(() => json({ nope: true })),
      (h) =>
        Effect.gen(function* () {
          yield* h.write(h.authFile, { token: "test" });
          yield* h.write(h.projectFile, { projectId, orgId: teamId });
          const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: expiredToken() }));
          assert.include(
            message,
            "Vercel OIDC token is malformed. Expected a string-valued token property.",
          );
        }),
    ),
  );

  it.effect("reports a failure to save the token", () =>
    scenario(issuing(validToken()), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test" });
        yield* h.write(h.projectFile, { projectId });
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.chmod(h.tokenDir, 0o500));
        const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: expiredToken() }));
        assert.include(message, "Failed to save the Vercel OIDC token");
      }),
    ),
  );
});

describe("vercelOidcRefreshing: project link", () => {
  it.effect("asks to link the project when project.json is missing", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test" });
        const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: expiredToken() }));
        assert.include(
          message,
          "project.json not found, have you linked your project with `vc link?`",
        );
      }),
    ),
  );

  it.effect("asks to link the project when no .vercel directory exists", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const message = yield* failure(
          h.token({ VERCEL_OIDC_TOKEN: expiredToken() }, { cwd: `${h.tmp}/data` }),
        );
        assert.include(
          message,
          "Unable to find project root directory. Have you linked your project with `vc link?`",
        );
      }),
    ),
  );

  it.effect("finds the linked project from a nested directory", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.projectFile, { projectId });
        yield* h.write(h.tokenFile(), { token: validToken("saved") });
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.makeDirectory(`${h.root}/src/app`, { recursive: true }),
        );
        assert.strictEqual(yield* h.token({}, { cwd: `${h.root}/src/app` }), validToken("saved"));
      }),
    ),
  );

  it.effect("rejects a project.json without a projectId or orgId", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.projectFile, { settings: {} });
        const message = yield* failure(h.token());
        assert.include(message, "Expected a string-valued projectId property");
      }),
    ),
  );
});

describe("vercelOidcRefreshing: Vercel CLI credentials", () => {
  const oauth = (body: unknown, status = 200) =>
    vercelApi(
      () => json({ token: validToken("new") }),
      () => json(body, status),
    );

  const expiredAuth = (h: Harness, auth: Record<string, unknown>) =>
    Effect.all([h.write(h.authFile, auth), h.write(h.projectFile, { projectId, orgId: teamId })]);

  it.effect("uses a valid CLI token as is", () =>
    scenario(issuing(validToken("new")), (h) =>
      Effect.gen(function* () {
        const auth = {
          token: "valid-access-token",
          refreshToken: "r",
          expiresAt: now / 1000 + 3600,
        };
        yield* expiredAuth(h, auth);
        yield* h.token({ VERCEL_OIDC_TOKEN: expiredToken() });
        const [request] = yield* h.requests(projectTokenPath());
        assert.strictEqual(request?.headers.authorization, "Bearer valid-access-token");
        assert.deepStrictEqual(yield* h.read(h.authFile), auth);
      }),
    ),
  );

  it.effect("treats a CLI token without expiresAt as valid", () =>
    scenario(issuing(validToken("new")), (h) =>
      Effect.gen(function* () {
        yield* expiredAuth(h, { token: "cli-provided-token" });
        yield* h.token({ VERCEL_OIDC_TOKEN: expiredToken() });
        const [request] = yield* h.requests(projectTokenPath());
        assert.strictEqual(request?.headers.authorization, "Bearer cli-provided-token");
        assert.strictEqual((yield* h.requests(tokenEndpointPath)).length, 0);
      }),
    ),
  );

  it.effect("fails when the CLI auth file is missing", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.projectFile, { projectId, orgId: teamId });
        const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: expiredToken() }));
        assert.include(
          message,
          "No authentication found. Please log in with the Vercel CLI (vercel login).",
        );
      }),
    ),
  );

  it.effect("refreshes an expired CLI token with the OAuth refresh token", () =>
    scenario(
      oauth({
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token: "new-refresh",
      }),
      (h) =>
        Effect.gen(function* () {
          yield* expiredAuth(h, {
            token: "expired",
            refreshToken: "valid-refresh-token",
            expiresAt: now / 1000 - 3600,
          });
          yield* h.token({ VERCEL_OIDC_TOKEN: expiredToken() });
          const [discovery] = yield* h.requests("/.well-known/openid-configuration");
          assert.strictEqual(discovery?.headers["x-test-origin"], "https://vercel.com");
          const [refresh] = yield* h.requests(tokenEndpointPath);
          assert.strictEqual(refresh?.headers["content-type"], "application/x-www-form-urlencoded");
          assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(refresh?.text)), {
            client_id: "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp",
            grant_type: "refresh_token",
            refresh_token: "valid-refresh-token",
          });
          const [project] = yield* h.requests(projectTokenPath());
          assert.strictEqual(project?.headers.authorization, "Bearer new-access-token");
          assert.deepStrictEqual(yield* h.read(h.authFile), {
            token: "new-access-token",
            expiresAt: now / 1000 + 7200,
            refreshToken: "new-refresh",
          });
        }),
    ),
  );

  it.effect(
    "refreshes when only a refresh token is stored and keeps it when none is returned",
    () =>
      scenario(
        oauth({ access_token: "new-access-token", token_type: "Bearer", expires_in: 3600 }),
        (h) =>
          Effect.gen(function* () {
            yield* expiredAuth(h, { refreshToken: "existing-refresh-token" });
            yield* h.token({ VERCEL_OIDC_TOKEN: expiredToken() });
            assert.deepStrictEqual(yield* h.read(h.authFile), {
              token: "new-access-token",
              expiresAt: now / 1000 + 3600,
              refreshToken: "existing-refresh-token",
            });
          }),
      ),
  );

  it.effect("clears the auth file when the token expired and there is no refresh token", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* expiredAuth(h, { token: "expired", expiresAt: now / 1000 - 3600 });
        const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: expiredToken() }));
        assert.include(message, "Failed to refresh authentication token.");
        assert.deepStrictEqual(yield* h.read(h.authFile), {});
      }),
    ),
  );

  it.effect("clears the auth file when the OAuth refresh is rejected", () =>
    scenario(
      oauth({ error: "invalid_grant", error_description: "Refresh token expired" }, 400),
      (h) =>
        Effect.gen(function* () {
          yield* expiredAuth(h, {
            token: "expired",
            refreshToken: "bad",
            expiresAt: now / 1000 - 3600,
          });
          const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: expiredToken() }));
          assert.include(message, "Failed to refresh authentication token.");
          assert.deepStrictEqual(yield* h.read(h.authFile), {});
        }),
    ),
  );

  it.effect("clears the auth file when the OAuth refresh cannot connect", () =>
    scenario(
      (request) =>
        request.url === "/.well-known/openid-configuration"
          ? json({ token_endpoint: "http://127.0.0.1:1/token" })
          : json({}, 404),
      (h) =>
        Effect.gen(function* () {
          yield* expiredAuth(h, {
            token: "expired",
            refreshToken: "r",
            expiresAt: now / 1000 - 3600,
          });
          const message = yield* failure(h.token({ VERCEL_OIDC_TOKEN: expiredToken() }));
          assert.include(message, "Failed to refresh authentication token.");
          assert.deepStrictEqual(yield* h.read(h.authFile), {});
        }),
    ),
  );
});

describe("vercelOidcRefreshing: keyring credentials", () => {
  it.effect("runs `vercel project token` when the CLI keeps credentials in the keyring", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.projectFile, { projectId });
        yield* h.cli(JSON.stringify({ token: validToken("cli") }));
        const result = yield* h.token({
          VERCEL_OIDC_TOKEN: expiredToken(),
          VERCEL_TOKEN_STORAGE: "keyring",
        });
        assert.strictEqual(result, validToken("cli"));
        assert.deepStrictEqual(yield* h.cliArgs, ["project", "token", projectId, "--format=json"]);
        assert.strictEqual((yield* h.server.requests).length, 0);
        assert.deepStrictEqual(yield* h.read(h.tokenFile()), { token: validToken("cli") });
      }),
    ),
  );

  it.effect("passes the team as --scope", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.cli(JSON.stringify({ token: validToken("cli") }));
        yield* h.token(
          { VERCEL_TOKEN_STORAGE: "keyring" },
          { project: projectId, team: "team_customscope123" },
        );
        assert.deepStrictEqual(yield* h.cliArgs, [
          "project",
          "token",
          projectId,
          "--format=json",
          "--scope",
          "team_customscope123",
        ]);
      }),
    ),
  );

  it.effect("reports malformed CLI output", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.cli(JSON.stringify({ nope: "missing-token" }));
        const message = yield* failure(
          h.token({ VERCEL_TOKEN_STORAGE: "keyring" }, { project: projectId, team: teamId }),
        );
        assert.include(
          message,
          "Failed to refresh OIDC token with the Vercel CLI: Vercel OIDC token is malformed. Expected a string-valued token property.",
        );
      }),
    ),
  );

  it.effect("reports CLI output that is not JSON", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.cli("Error!");
        const message = yield* failure(
          h.token({ VERCEL_TOKEN_STORAGE: "keyring" }, { project: projectId, team: teamId }),
        );
        assert.include(message, "`vercel project token` returned invalid JSON: Error!");
      }),
    ),
  );

  it.effect("includes the CLI stderr when the command fails", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.cli("", { stderr: "Project not found for this scope\n", exitCode: 1 });
        const message = yield* failure(
          h.token({ VERCEL_TOKEN_STORAGE: "keyring" }, { project: projectId, team: teamId }),
        );
        assert.include(
          message,
          "Failed to refresh OIDC token with the Vercel CLI: Command failed with exit code 1\nProject not found for this scope",
        );
      }),
    ),
  );

  it.effect("reads credStorage from the CLI config file", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(`${h.cliDir}/config.json`, { credStorage: "keyring" });
        yield* h.cli(JSON.stringify({ token: validToken("cli") }));
        assert.strictEqual(
          yield* h.token({}, { project: projectId, team: teamId }),
          validToken("cli"),
        );
      }),
    ),
  );

  it.effect(
    "with credStorage auto, uses auth.json when it holds a token and the keyring otherwise",
    () =>
      scenario(issuing(validToken("api")), (h) =>
        Effect.gen(function* () {
          yield* h.cli(JSON.stringify({ token: validToken("cli") }));
          const options = { project: projectId, team: teamId };
          assert.strictEqual(
            yield* h.token({ VERCEL_TOKEN_STORAGE: "auto" }, options),
            validToken("cli"),
          );
          yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(h.tokenFile()));
          yield* h.write(h.authFile, { token: "test" });
          assert.strictEqual(
            yield* h.token({ VERCEL_TOKEN_STORAGE: "auto" }, options),
            validToken("api"),
          );
        }),
      ),
  );

  it.effect("rejects an invalid VERCEL_TOKEN_STORAGE", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        const message = yield* failure(
          h.token({ VERCEL_TOKEN_STORAGE: "vault" }, { project: projectId, team: teamId }),
        );
        assert.include(
          message,
          'Invalid value for `VERCEL_TOKEN_STORAGE`: "vault". Expected one of: "auto", "file", "keyring".',
        );
      }),
    ),
  );

  it.effect("checks the token file before the keyring", () =>
    scenario(issuing("unused"), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.tokenFile(), { token: validToken("cached") });
        const result = yield* h.token(
          { VERCEL_TOKEN_STORAGE: "keyring" },
          { project: projectId, team: teamId },
        );
        assert.strictEqual(result, validToken("cached"));
        assert.isFalse(yield* h.exists(`${h.tmp}/bin/args.txt`));
      }),
    ),
  );
});

describe("vercelOidcRefreshing: caching", () => {
  it.effect("does not refresh twice while the refreshed token is valid", () =>
    scenario(issuing(validToken("new")), (h) =>
      Effect.gen(function* () {
        yield* h.write(h.authFile, { token: "test" });
        yield* h.write(h.projectFile, { projectId });
        const both = Effect.gen(function* () {
          const oidc = yield* VercelOidc;
          const first = Redacted.value(yield* oidc.token);
          yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(h.tokenFile()));
          const second = Redacted.value(yield* oidc.token);
          return [first, second];
        });
        const layer = vercelOidcRefreshing({ cwd: h.root }).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              RedirectingHttpClient,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ ...h.env, VERCEL_OIDC_TOKEN: expiredToken() }),
              ),
            ),
          ),
        );
        const [first, second] = yield* both.pipe(
          Effect.provide(layer),
          Effect.provideService(TestHttpServer, h.server),
        );
        assert.strictEqual(first, validToken("new"));
        assert.strictEqual(second, validToken("new"));
        assert.strictEqual((yield* h.requests(projectTokenPath())).length, 1);
      }),
    ),
  );
});
