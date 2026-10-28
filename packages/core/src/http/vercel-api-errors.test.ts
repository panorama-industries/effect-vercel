import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Option, Predicate } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import type { VercelApiError } from "../contracts/vercel-api-error.ts";
import type { TestHttpResponse } from "../testing/test-http-server.ts";

import { TestHttpServer, TestHttpServerLive } from "../testing/test-http-server.ts";
import {
  vercelApiErrorFromHttpClientError,
  vercelApiErrorFromResponse,
} from "./vercel-api-errors.ts";

const TestLayer = Layer.merge(TestHttpServerLive(), FetchHttpClient.layer);

const errorFor = (reply: TestHttpResponse, errorCodeHeader?: string) =>
  Effect.gen(function* () {
    const server = yield* TestHttpServer;
    yield* server.enqueue(reply);
    const response = yield* (yield* HttpClient.HttpClient).get(`${server.url}/op`);
    return yield* Effect.flip(
      vercelApiErrorFromResponse(response, { operation: "Test.op", errorCodeHeader }),
    );
  });

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): TestHttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("vercelApiErrorFromResponse", () => {
  it.effect.each([
    { status: 400, tag: "ApiBadRequest" },
    { status: 401, tag: "ApiUnauthorized" },
    { status: 403, tag: "ApiForbidden" },
    { status: 413, tag: "ApiPayloadTooLarge" },
    { status: 429, tag: "ApiRateLimited" },
    { status: 500, tag: "ApiServerError" },
    { status: 503, tag: "ApiServerError" },
    { status: 404, tag: "ApiUnexpectedResponse" },
    { status: 409, tag: "ApiUnexpectedResponse" },
  ])("maps $status to $tag", ({ status, tag }) =>
    Effect.gen(function* () {
      const error = yield* errorFor(json(status, { error: "boom" }));
      assert.strictEqual(error.reason._tag, tag);
      assert.strictEqual(error.reason.message, "boom");
      assert.strictEqual(error.operation, "Test.op");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps the status of server errors and unexpected responses", () =>
    Effect.gen(function* () {
      const server = yield* errorFor(json(502, {}));
      const other = yield* errorFor(json(418, {}));
      assert.isTrue(
        Predicate.isTagged(server.reason, "ApiServerError") && server.reason.status === 502,
      );
      assert.isTrue(
        Predicate.isTagged(other.reason, "ApiUnexpectedResponse") && other.reason.status === 418,
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect.each([
    { name: "a JSON error string", reply: json(400, { error: "bad topic" }), message: "bad topic" },
    { name: "a JSON message", reply: json(400, { message: "bad topic" }), message: "bad topic" },
    {
      name: "a nested JSON error",
      reply: json(400, { error: { code: "bad", message: "bad topic" } }),
      message: "bad topic",
    },
    {
      name: "a text body",
      reply: { status: 400, headers: { "content-type": "text/plain" }, body: " bad topic \n" },
      message: "bad topic",
    },
    {
      name: "an unrecognized body",
      reply: { status: 400, headers: { "content-type": "application/octet-stream" }, body: "x" },
      message: "HTTP 400",
    },
    { name: "an empty body", reply: { status: 400 }, message: "HTTP 400" },
  ])("reads the message from $name", ({ reply, message }) =>
    Effect.gen(function* () {
      const error = yield* errorFor(reply);
      assert.strictEqual(error.reason.message, message);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reads the error code header when asked", () =>
    Effect.gen(function* () {
      const withCode = yield* errorFor(
        json(400, {}, { "Vqs-Error-Code": "INVALID_TOPIC" }),
        "Vqs-Error-Code",
      );
      const withoutHeaderName = yield* errorFor(
        json(400, {}, { "Vqs-Error-Code": "INVALID_TOPIC" }),
      );
      assert.deepStrictEqual(withCode.errorCode, Option.some("INVALID_TOPIC"));
      assert.deepStrictEqual(withoutHeaderName.errorCode, Option.none());
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reads Retry-After seconds and dates on 429", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2025-01-01T00:00:00Z"));
      const retryAfter = (error: VercelApiError) =>
        Predicate.isTagged(error.reason, "ApiRateLimited")
          ? Option.map(error.reason.retryAfter, Duration.toMillis)
          : Option.none();
      const seconds = yield* errorFor(json(429, {}, { "Retry-After": "7" }));
      const date = yield* errorFor(
        json(429, {}, { "Retry-After": "Wed, 01 Jan 2025 00:00:30 GMT" }),
      );
      const invalid = yield* errorFor(json(429, {}, { "Retry-After": "soon" }));
      const missing = yield* errorFor(json(429, {}));
      assert.deepStrictEqual(retryAfter(seconds), Option.some(7000));
      assert.deepStrictEqual(retryAfter(date), Option.some(30_000));
      assert.deepStrictEqual(retryAfter(invalid), Option.none());
      assert.deepStrictEqual(retryAfter(missing), Option.none());
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("vercelApiErrorFromHttpClientError", () => {
  it.effect("maps transport failures to ApiNetworkFailure", () =>
    Effect.gen(function* () {
      const url = yield* Effect.gen(function* () {
        return (yield* TestHttpServer).url;
      }).pipe(Effect.provide(TestHttpServerLive()));
      const error = yield* (yield* HttpClient.HttpClient).get(url).pipe(
        Effect.catchTag("HttpClientError", (error) =>
          vercelApiErrorFromHttpClientError(error, { operation: "Test.op" }),
        ),
        Effect.flip,
      );
      assert.strictEqual(error.reason._tag, "ApiNetworkFailure");
      assert.strictEqual(error.operation, "Test.op");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("maps status errors like a response", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      yield* server.enqueue(json(401, { error: "expired token" }, { "Vqs-Error-Code": "AUTH" }));
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const error = yield* client.get(`${server.url}/op`).pipe(
        Effect.catchTag("HttpClientError", (error) =>
          vercelApiErrorFromHttpClientError(error, {
            operation: "Test.op",
            errorCodeHeader: "vqs-error-code",
          }),
        ),
        Effect.flip,
      );
      assert.strictEqual(error.reason._tag, "ApiUnauthorized");
      assert.strictEqual(error.reason.message, "expired token");
      assert.deepStrictEqual(error.errorCode, Option.some("AUTH"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("maps unreadable bodies to ApiUnexpectedResponse", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      yield* server.enqueue({
        status: 200,
        headers: { "content-type": "application/json" },
        body: "{",
      });
      const error = yield* (yield* HttpClient.HttpClient).get(`${server.url}/op`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.catchTag("HttpClientError", (error) =>
          vercelApiErrorFromHttpClientError(error, { operation: "Test.op" }),
        ),
        Effect.flip,
      );
      assert.isTrue(
        Predicate.isTagged(error.reason, "ApiUnexpectedResponse") && error.reason.status === 200,
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("treats invalid URLs as defects", () =>
    Effect.gen(function* () {
      const exit = yield* (yield* HttpClient.HttpClient)
        .execute(HttpClientRequest.get("http://["))
        .pipe(
          Effect.catchTag("HttpClientError", (error) =>
            vercelApiErrorFromHttpClientError(error, { operation: "Test.op" }),
          ),
          Effect.exit,
        );
      assert.isTrue(Exit.isFailure(exit) && exit.cause.reasons.some(Predicate.isTagged("Die")));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
