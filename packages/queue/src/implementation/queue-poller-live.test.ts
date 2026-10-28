import type { VercelApiErrorReason } from "@panorama-industries/effect-vercel-core";

import { assert, describe, it } from "@effect/vitest";
import {
  ApiBadRequest,
  ApiForbidden,
  ApiRateLimited,
  ApiServerError,
  ApiUnauthorized,
  VercelApiError,
  VercelRegion,
} from "@panorama-industries/effect-vercel-core";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";

import { RetryDirective } from "../contracts/message-handling.ts";
import { QueueApi, ReceiveLimit } from "../contracts/queue-api.ts";
import {
  ConsumerGroupName,
  MessageId,
  MessageNotAvailable,
  MessageNotFound,
  MessageUnavailable,
} from "../contracts/queue-domain.ts";
import { QueuePoller, ReceiveOutcome } from "../contracts/queue-poller.ts";
import { Topic } from "../contracts/topic.ts";
import { TestQueue } from "../testing/test-queue.ts";
import { QueuePollerLive } from "./queue-poller-live.ts";

const Order = Schema.Struct({ id: Schema.String });
const Orders = Topic.json("orders", Order);
const group = ConsumerGroupName.make("fulfilment");
const lhr1 = VercelRegion.make("lhr1");

const TestLayer = QueuePollerLive.pipe(Layer.provideMerge(TestQueue.layer));

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  id: Schema.String,
}) {}

const publish = (id: string) =>
  Effect.gen(function* () {
    const api = yield* QueueApi;
    const result = yield* api.send(Orders.name, {
      body: yield* Schema.encodeEffect(Orders.wire)({ id }),
      contentType: Orders.contentType,
    });
    return (result as { readonly messageId: MessageId }).messageId;
  });

const calls = TestQueue.use((queue) => queue.calls);

const renewalTimes = Effect.map(calls, (all) =>
  all.filter((call) => call.operation === "changeVisibility").map((call) => call.at),
);

const status = (messageId: MessageId) =>
  TestQueue.use((queue) => queue.delivery(Orders.name, group, messageId)).pipe(
    Effect.map(Option.map((state) => state.status)),
  );

const apiError = (reason: VercelApiErrorReason) =>
  new VercelApiError({ operation: "QueueApi.changeVisibility", errorCode: Option.none(), reason });

describe("QueuePollerLive", () => {
  describe("receive", () => {
    it.effect("reports Empty when nothing is available", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const outcome = yield* poller.receive(Orders, group, () => Effect.void);
        assert.deepStrictEqual(outcome, ReceiveOutcome.Empty());
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("passes limit, cursor fallback, region and lease length to the queue", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        yield* poller.receive(Orders, group, () => Effect.void, {
          limit: ReceiveLimit.make(4),
          cursorFallback: "earliest",
          region: lhr1,
          visibilityTimeout: "2 minutes",
        });
        const [call] = yield* calls;
        assert.strictEqual(call?.limit, 4);
        assert.strictEqual(call?.cursorFallback, "earliest");
        assert.strictEqual(call?.region, lhr1);
        assert.deepStrictEqual(call?.visibilityTimeout, Duration.minutes(2));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("handles a batch concurrently and acknowledges each message", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const ids = [yield* publish("a"), yield* publish("b"), yield* publish("c")];
        const started = yield* Ref.make(0);
        const allStarted = yield* Deferred.make<void>();
        const outcome = yield* poller.receive(
          Orders,
          group,
          () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(started, (n) => n + 1);
              if (count === 3) yield* Deferred.succeed(allStarted, undefined);
              yield* Deferred.await(allStarted);
            }),
          { limit: ReceiveLimit.make(10) },
        );
        assert.deepStrictEqual(outcome, ReceiveOutcome.Processed({ count: 3 }));
        for (const id of ids) {
          assert.deepStrictEqual(yield* status(id), Option.some("acknowledged"));
        }
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("settles every message and returns the first failure when the policy fails", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const [a, b, c] = [yield* publish("a"), yield* publish("b"), yield* publish("c")];
        const error = yield* poller
          .receive(
            Orders,
            group,
            (order) =>
              order.id === "a" ? Effect.void : Effect.fail(new OutOfStock({ id: order.id })),
            { limit: ReceiveLimit.make(3) },
          )
          .pipe(Effect.flip);
        assert.deepStrictEqual(error, new OutOfStock({ id: "b" }));
        assert.deepStrictEqual(yield* status(a!), Option.some("acknowledged"));
        assert.deepStrictEqual(yield* status(b!), Option.some("leased"));
        assert.deepStrictEqual(yield* status(c!), Option.some("leased"));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reports an undecodable payload as MessageCorrupted", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const api = yield* QueueApi;
        yield* api.send(Orders.name, {
          body: new TextEncoder().encode("[]"),
          contentType: "application/json",
        });
        const error = yield* poller.receive(Orders, group, () => Effect.void).pipe(Effect.flip);
        assert.strictEqual(error._tag, "MessageCorrupted");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with the lease error when the acknowledgment is refused", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const queue = yield* TestQueue;
        yield* publish("a");
        const lost = new MessageNotAvailable({
          messageId: "msg_1",
          reason: new MessageUnavailable({ message: "lease lost" }),
        });
        yield* queue.failNext("acknowledge", lost);
        const error = yield* poller.receive(Orders, group, () => Effect.void).pipe(Effect.flip);
        assert.deepStrictEqual(error, lost);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails with MessageNotAvailable when coalesced reruns are exhausted", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const queue = yield* TestQueue;
        const id = yield* publish("a");
        const error = yield* poller
          .receive(Orders, group, () => queue.coalesce(Orders.name, group, id, 1))
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "MessageNotAvailable");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reruns once per refusal up to the configured maximum", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const queue = yield* TestQueue;
        const id = yield* publish("a");
        const runs = yield* Ref.make(0);
        const errors = yield* Ref.make<Array<string>>([]);
        yield* poller.receive(
          Orders,
          group,
          () =>
            Effect.gen(function* () {
              const run = yield* Ref.updateAndGet(runs, (n) => n + 1);
              yield* queue.coalesce(Orders.name, group, id, run);
            }),
          {
            experimentalMaxCoalescedReruns: 2,
            onError: (error) =>
              Ref.update(errors, (all) => [...all, error._tag]).pipe(
                Effect.as(RetryDirective.Acknowledge()),
              ),
          },
        );
        assert.strictEqual(yield* Ref.get(runs), 3);
        assert.deepStrictEqual(yield* Ref.get(errors), ["ConcurrencyCoalescedPending"]);
        assert.deepStrictEqual(
          (yield* calls)
            .filter((call) => call.operation === "acknowledge")
            .map((call) => call.experimentalIfCoalesced),
          [undefined, 1, 2, undefined],
        );
        // The policy's plain acknowledgment covers no coalesced messages, so it is refused too.
        assert.deepStrictEqual(yield* status(id), Option.some("leased"));
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("receiveById", () => {
    it.effect("processes the message", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const id = yield* publish("a");
        const outcome = yield* poller.receiveById(Orders, group, id, () => Effect.void, {
          region: lhr1,
        });
        assert.deepStrictEqual(outcome, ReceiveOutcome.Processed({ count: 1 }));
        assert.deepStrictEqual(
          (yield* calls).slice(1).map((call) => [call.operation, call.region]),
          [
            ["receiveById", lhr1],
            ["acknowledge", lhr1],
          ],
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reports NotFound, NotAvailable and AlreadyProcessed", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const api = yield* QueueApi;
        const missing = MessageId.make("msg_missing");
        assert.deepStrictEqual(
          yield* poller.receiveById(Orders, group, missing, () => Effect.void),
          ReceiveOutcome.NotFound({ messageId: missing }),
        );

        const id = yield* publish("a");
        yield* api.receive(Orders.name, group);
        assert.deepStrictEqual(
          yield* poller.receiveById(Orders, group, id, () => Effect.void),
          ReceiveOutcome.NotAvailable({ messageId: id }),
        );

        yield* TestClock.adjust("31 seconds");
        yield* poller.receiveById(Orders, group, id, () => Effect.void);
        assert.deepStrictEqual(
          yield* poller.receiveById(Orders, group, id, () => Effect.void),
          ReceiveOutcome.AlreadyProcessed({ messageId: id }),
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reports a refused acknowledgment as an outcome, as the SDK does", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const queue = yield* TestQueue;
        const id = yield* publish("a");
        yield* queue.failNext("acknowledge", new MessageNotFound({ messageId: id }));
        assert.deepStrictEqual(
          yield* poller.receiveById(Orders, group, id, () => Effect.void),
          ReceiveOutcome.NotFound({ messageId: id }),
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("returns the handler's error when the policy answers Fail", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const id = yield* publish("a");
        const error = yield* poller
          .receiveById(Orders, group, id, () => Effect.fail(new OutOfStock({ id: "a" })), {
            onError: () => Effect.succeed(RetryDirective.Fail()),
          })
          .pipe(Effect.flip);
        assert.deepStrictEqual(error, new OutOfStock({ id: "a" }));
        assert.deepStrictEqual(yield* status(id), Option.some("leased"));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("propagates handler defects", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const id = yield* publish("a");
        const exit = yield* poller
          .receiveById(Orders, group, id, () => Effect.die("boom"), {
            onError: () => Effect.succeed(RetryDirective.Acknowledge()),
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
        assert.strictEqual(Exit.isFailure(exit) && Cause.squash(exit.cause), "boom");
        assert.deepStrictEqual(yield* status(id), Option.some("leased"));
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("lease renewal", () => {
    const pollWhile = (handlerTime: Duration.Input, visibilityTimeout?: Duration.Input) =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        yield* publish("a");
        const fiber = yield* poller
          .receive(
            Orders,
            group,
            () => Effect.sleep(handlerTime),
            visibilityTimeout === undefined ? {} : { visibilityTimeout },
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(handlerTime);
        return yield* Fiber.join(fiber);
      });

    it.effect("renews a 5-minute lease every 60 seconds and stops after the handler", () =>
      Effect.gen(function* () {
        const outcome = yield* pollWhile("150 seconds");
        assert.deepStrictEqual(outcome, ReceiveOutcome.Processed({ count: 1 }));
        yield* TestClock.adjust("10 minutes");
        assert.deepStrictEqual(yield* renewalTimes, [60_000, 120_000]);
        const renewal = (yield* calls).find((call) => call.operation === "changeVisibility");
        assert.deepStrictEqual(renewal?.visibilityTimeout, Duration.minutes(5));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("keeps leases of messages waiting their turn alive with concurrency 1", () =>
      Effect.gen(function* () {
        const poller = yield* QueuePoller;
        const a = yield* publish("a");
        const b = yield* publish("b");
        const started = yield* Ref.make<ReadonlyArray<string>>([]);
        const fiber = yield* poller
          .receive(
            Orders,
            group,
            (order) =>
              Ref.update(started, (ids) => [...ids, order.id]).pipe(
                Effect.andThen(Effect.sleep("150 seconds")),
              ),
            { limit: ReceiveLimit.make(2), concurrency: 1, visibilityTimeout: "100 seconds" },
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("300 seconds");
        const outcome = yield* Fiber.join(fiber);
        assert.deepStrictEqual(outcome, ReceiveOutcome.Processed({ count: 2 }));
        assert.deepStrictEqual(yield* Ref.get(started), ["a", "b"]);
        assert.deepStrictEqual(yield* status(a), Option.some("acknowledged"));
        assert.deepStrictEqual(yield* status(b), Option.some("acknowledged"));
        const waitingRenewals = (yield* calls).filter(
          (call) =>
            call.operation === "changeVisibility" && call.messageId === b && call.at < 150_000,
        );
        assert.isTrue(waitingRenewals.length > 0);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("renews every visibilityTimeout / 5", () =>
      Effect.gen(function* () {
        yield* pollWhile("50 seconds", "100 seconds");
        assert.deepStrictEqual(yield* renewalTimes, [20_000, 40_000]);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("never renews more often than every 10 seconds", () =>
      Effect.gen(function* () {
        yield* pollWhile("25 seconds", "30 seconds");
        assert.deepStrictEqual(yield* renewalTimes, [10_000, 20_000]);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect.each([
      {
        name: "a server error",
        error: apiError(new ApiServerError({ message: "x", status: 502 })),
      },
      {
        name: "rate limiting",
        error: apiError(new ApiRateLimited({ message: "x", retryAfter: Option.none() })),
      },
    ])("retries after 3 seconds on $name", ({ error }) =>
      Effect.gen(function* () {
        const queue = yield* TestQueue;
        yield* queue.failNext("changeVisibility", error);
        yield* pollWhile("70 seconds");
        assert.deepStrictEqual(yield* renewalTimes, [60_000, 63_000]);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect.each([
      { name: "404", error: new MessageNotFound({ messageId: "msg_1" }) },
      {
        name: "409",
        error: new MessageNotAvailable({
          messageId: "msg_1",
          reason: new MessageUnavailable({ message: "lost" }),
        }),
      },
      { name: "400", error: apiError(new ApiBadRequest({ message: "x" })) },
      { name: "401", error: apiError(new ApiUnauthorized({ message: "x" })) },
      { name: "403", error: apiError(new ApiForbidden({ message: "x" })) },
    ])("stops renewing on $name", ({ error }) =>
      Effect.gen(function* () {
        const queue = yield* TestQueue;
        yield* queue.failNext("changeVisibility", error);
        yield* pollWhile("200 seconds", "10 minutes").pipe(Effect.ignore);
        assert.deepStrictEqual(yield* renewalTimes, [60_000]);
      }).pipe(Effect.provide(TestLayer)),
    );
  });
});
