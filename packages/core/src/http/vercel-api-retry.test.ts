import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Layer, Option, Predicate, Ref, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import {
  ApiNetworkFailure,
  ApiRateLimited,
  ApiServerError,
  ApiUnauthorized,
  VercelApiError,
} from "../contracts/vercel-api-error.ts";
import { TestHttpServer, TestHttpServerLive } from "../testing/test-http-server.ts";
import { vercelApiErrorFromResponse } from "./vercel-api-errors.ts";
import { vercelApiTransientRetry } from "./vercel-api-retry.ts";

class OtherError extends Schema.TaggedError<OtherError>()("OtherError", {}) {}

const apiError = (reason: VercelApiError["reason"]) =>
  new VercelApiError({ operation: "Test.op", errorCode: Option.none(), reason });

const networkFailure = apiError(new ApiNetworkFailure({ message: "reset", cause: null }));

const failingTimes = <E>(errors: ReadonlyArray<E>) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const effect = Effect.gen(function* () {
      const attempt = yield* Ref.getAndUpdate(attempts, (n) => n + 1);
      const error = errors[attempt];
      if (error !== undefined) {
        return yield* Effect.fail(error);
      }
      return "ok";
    });
    return { attempts, effect };
  });

const runToEnd = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("1 hour");
    return yield* Fiber.await(fiber);
  });

describe("vercelApiTransientRetry", () => {
  it.effect("retries network failures until success", () =>
    Effect.gen(function* () {
      const { attempts, effect } = yield* failingTimes([networkFailure, networkFailure]);
      const exit = yield* runToEnd(effect.pipe(Effect.retry(vercelApiTransientRetry())));
      assert.deepStrictEqual(exit, Exit.succeed("ok"));
      assert.strictEqual(yield* Ref.get(attempts), 3);
    }),
  );

  it.effect("stops after three attempts by default", () =>
    Effect.gen(function* () {
      const { attempts, effect } = yield* failingTimes(
        Array.from({ length: 10 }, () => networkFailure),
      );
      const exit = yield* runToEnd(effect.pipe(Effect.retry(vercelApiTransientRetry())));
      assert.deepStrictEqual(exit, Exit.fail(networkFailure));
      assert.strictEqual(yield* Ref.get(attempts), 3);
    }),
  );

  it.effect("honors a configured maximum", () =>
    Effect.gen(function* () {
      const { attempts, effect } = yield* failingTimes(
        Array.from({ length: 10 }, () => networkFailure),
      );
      yield* runToEnd(effect.pipe(Effect.retry(vercelApiTransientRetry({ maxAttempts: 5 }))));
      assert.strictEqual(yield* Ref.get(attempts), 5);
      const once = yield* failingTimes([networkFailure]);
      yield* runToEnd(once.effect.pipe(Effect.retry(vercelApiTransientRetry({ maxAttempts: 1 }))));
      assert.strictEqual(yield* Ref.get(once.attempts), 1);
    }),
  );

  it.effect.each([
    { name: "ApiUnauthorized", error: apiError(new ApiUnauthorized({ message: "no" })) },
    { name: "ApiServerError", error: apiError(new ApiServerError({ message: "no", status: 500 })) },
    { name: "a non-API error", error: new OtherError() },
  ])("does not retry $name", ({ error }) =>
    Effect.gen(function* () {
      const { attempts, effect } = yield* failingTimes<unknown>([error]);
      const exit = yield* runToEnd(effect.pipe(Effect.retry(vercelApiTransientRetry())));
      assert.deepStrictEqual(exit, Exit.fail(error));
      assert.strictEqual(yield* Ref.get(attempts), 1);
    }),
  );

  it.effect("waits the Retry-After delay of a rate-limited call", () =>
    Effect.gen(function* () {
      const rateLimited = apiError(
        new ApiRateLimited({ message: "slow down", retryAfter: Option.some(Duration.seconds(10)) }),
      );
      const { attempts, effect } = yield* failingTimes([rateLimited]);
      const fiber = yield* Effect.forkChild(effect.pipe(Effect.retry(vercelApiTransientRetry())));
      yield* TestClock.adjust("9 seconds");
      assert.strictEqual(yield* Ref.get(attempts), 1);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(fiber), "ok");
      assert.strictEqual(yield* Ref.get(attempts), 2);
    }),
  );

  it.effect("backs off exponentially without Retry-After", () =>
    Effect.gen(function* () {
      const rateLimited = apiError(
        new ApiRateLimited({ message: "slow down", retryAfter: Option.none() }),
      );
      const { attempts, effect } = yield* failingTimes([rateLimited, rateLimited]);
      const fiber = yield* Effect.forkChild(
        effect.pipe(Effect.retry(vercelApiTransientRetry({ baseDelay: "1 second" }))),
      );
      yield* TestClock.adjust("700 millis");
      assert.strictEqual(yield* Ref.get(attempts), 1);
      yield* TestClock.adjust("600 millis");
      assert.strictEqual(yield* Ref.get(attempts), 2);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Ref.get(attempts), 2);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(yield* Fiber.join(fiber), "ok");
    }),
  );

  describe("with isRetryable", () => {
    const serverError = (status: number) =>
      apiError(new ApiServerError({ message: "down", status }));
    const rateLimited = apiError(
      new ApiRateLimited({ message: "slow down", retryAfter: Option.some(Duration.seconds(10)) }),
    );
    const networkOrBadGateway = (error: unknown) =>
      error instanceof VercelApiError &&
      (Predicate.isTagged(error.reason, "ApiNetworkFailure") ||
        (Predicate.isTagged(error.reason, "ApiServerError") && error.reason.status === 502));

    it.effect("retries the failures it accepts", () =>
      Effect.gen(function* () {
        const { attempts, effect } = yield* failingTimes([networkFailure, serverError(502)]);
        const exit = yield* runToEnd(
          effect.pipe(Effect.retry(vercelApiTransientRetry({ isRetryable: networkOrBadGateway }))),
        );
        assert.deepStrictEqual(exit, Exit.succeed("ok"));
        assert.strictEqual(yield* Ref.get(attempts), 3);
      }),
    );

    it.effect.each([
      { name: "ApiRateLimited", error: rateLimited },
      { name: "another server error", error: serverError(500) },
    ])("does not retry $name when it rejects it", ({ error }) =>
      Effect.gen(function* () {
        const { attempts, effect } = yield* failingTimes([error]);
        const exit = yield* runToEnd(
          effect.pipe(Effect.retry(vercelApiTransientRetry({ isRetryable: networkOrBadGateway }))),
        );
        assert.deepStrictEqual(exit, Exit.fail(error));
        assert.strictEqual(yield* Ref.get(attempts), 1);
      }),
    );

    it.effect("still waits the Retry-After delay of an accepted rate-limited call", () =>
      Effect.gen(function* () {
        const { attempts, effect } = yield* failingTimes([rateLimited]);
        const fiber = yield* Effect.forkChild(
          effect.pipe(
            Effect.retry(
              vercelApiTransientRetry({ isRetryable: () => true, baseDelay: "1 millis" }),
            ),
          ),
        );
        yield* TestClock.adjust("9 seconds");
        assert.strictEqual(yield* Ref.get(attempts), 1);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Fiber.join(fiber), "ok");
      }),
    );

    it.effect("keeps the attempt limit", () =>
      Effect.gen(function* () {
        const { attempts, effect } = yield* failingTimes(
          Array.from({ length: 20 }, () => networkFailure),
        );
        yield* runToEnd(
          effect.pipe(
            Effect.retry(
              vercelApiTransientRetry({
                maxAttempts: 11,
                baseDelay: "1 second",
                isRetryable: () => true,
              }),
            ),
          ),
        );
        assert.strictEqual(yield* Ref.get(attempts), 11);
      }),
    );
  });

  it.live("retries a 429 response end to end", () =>
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      yield* server.enqueue(
        { status: 429, headers: { "retry-after": "0" } },
        { status: 200, body: "done" },
      );
      const client = yield* HttpClient.HttpClient;
      const call = client.get(`${server.url}/op`).pipe(
        Effect.orDie,
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.orDie(response.text)
            : vercelApiErrorFromResponse(response, { operation: "Test.op" }),
        ),
        Effect.retry(vercelApiTransientRetry()),
      );
      assert.strictEqual(yield* call, "done");
      assert.strictEqual((yield* server.requests).length, 2);
    }).pipe(Effect.provide(Layer.merge(TestHttpServerLive(), FetchHttpClient.layer))),
  );
});
