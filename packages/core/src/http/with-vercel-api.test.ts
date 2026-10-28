import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Redacted, Ref } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { OidcTokenUnavailable } from "../contracts/vercel-oidc.ts";
import { TestHttpServer, TestHttpServerLive } from "../testing/test-http-server.ts";
import { withVercelApi } from "./with-vercel-api.ts";

const TestLayer = Layer.merge(
  TestHttpServerLive({ handler: () => ({ status: 200 }) }),
  FetchHttpClient.layer,
);

describe("withVercelApi", () => {
  it.effect("prepends the base URL and sets auth, user agent and extra headers", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const client = (yield* HttpClient.HttpClient).pipe(
        withVercelApi({
          baseUrl: `${server.url}/api/v3`,
          token: Effect.succeed(Redacted.make("oidc-token")),
          userAgent: "@panorama-industries/effect-vercel-queue/0.0.0",
          headers: { "Vqs-Deployment-Id": "dpl_1" },
        }),
      );
      yield* client.post("/topic/orders");
      const [request] = yield* server.requests;
      assert.strictEqual(request?.url, "/api/v3/topic/orders");
      assert.strictEqual(request?.headers.authorization, "Bearer oidc-token");
      assert.strictEqual(
        request?.headers["user-agent"],
        "@panorama-industries/effect-vercel-queue/0.0.0",
      );
      assert.strictEqual(request?.headers["vqs-deployment-id"], "dpl_1");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("evaluates the token for every request", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const counter = yield* Ref.make(0);
      const client = (yield* HttpClient.HttpClient).pipe(
        withVercelApi({
          baseUrl: server.url,
          token: Ref.updateAndGet(counter, (n) => n + 1).pipe(
            Effect.map((n) => Redacted.make(`token-${n}`)),
          ),
          userAgent: "test",
        }),
      );
      yield* client.get("/a");
      yield* client.get("/b");
      const requests = yield* server.requests;
      assert.deepStrictEqual(
        requests.map((request) => request.headers.authorization),
        ["Bearer token-1", "Bearer token-2"],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with the token error without sending the request", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      const client = (yield* HttpClient.HttpClient).pipe(
        withVercelApi({
          baseUrl: server.url,
          token: Effect.fail(new OidcTokenUnavailable({ message: "no token" })),
          userAgent: "test",
        }),
      );
      const exit = yield* Effect.exit(client.get("/a"));
      assert.deepStrictEqual(exit, Exit.fail(new OidcTokenUnavailable({ message: "no token" })));
      assert.strictEqual((yield* server.requests).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
