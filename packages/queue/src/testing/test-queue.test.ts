import { assert, describe, it } from "@effect/vitest";
import { VercelRegion } from "@panorama-industries/effect-vercel-core";
import { Duration, Effect, Option, Predicate } from "effect";
import { TestClock } from "effect/testing";

import { QueueApi, ReceiveLimit } from "../contracts/queue-api.ts";
import {
  ConsumerGroupName,
  IdempotencyKey,
  MessageHandle,
  MessageId,
  ReceiptHandle,
  TopicName,
} from "../contracts/queue-domain.ts";
import { TestQueue } from "./test-queue.ts";

const topic = TopicName.make("orders");
const group = ConsumerGroupName.make("fulfilment");
const body = new TextEncoder().encode("{}");

const send = (
  options: { readonly delay?: Duration.Input; readonly idempotencyKey?: string } = {},
) =>
  Effect.gen(function* () {
    const api = yield* QueueApi;
    const result = yield* api.send(topic, {
      body,
      contentType: "application/json",
      ...(options.delay === undefined ? {} : { delay: options.delay }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: IdempotencyKey.make(options.idempotencyKey) }),
    });
    return (result as { readonly messageId: MessageId }).messageId;
  });

const receiveOne = (visibilityTimeout: Duration.Input = "30 seconds") =>
  QueueApi.use((api) => api.receive(topic, group, { visibilityTimeout })).pipe(
    Effect.map((messages) => messages[0]!),
  );

describe("TestQueue", () => {
  it.effect("leases each message once until its visibility timeout expires", () =>
    Effect.gen(function* () {
      const api = yield* QueueApi;
      yield* send();
      const first = yield* receiveOne();
      assert.strictEqual(first.metadata.deliveryCount, 1);
      assert.deepStrictEqual(yield* api.receive(topic, group), []);

      yield* TestClock.adjust("30 seconds");
      const second = yield* receiveOne();
      assert.strictEqual(second.metadata.deliveryCount, 2);
      assert.notStrictEqual(second.handle.receiptHandle, first.handle.receiptHandle);

      const stale = yield* api.acknowledge(first.handle).pipe(Effect.flip);
      assert.strictEqual(stale._tag, "MessageNotAvailable");
      yield* api.acknowledge(second.handle);
      const gone = yield* api.acknowledge(second.handle).pipe(Effect.flip);
      assert.strictEqual(gone._tag, "MessageNotFound");
    }).pipe(Effect.provide(TestQueue.layer)),
  );

  it.effect("delivers every message to every consumer group", () =>
    Effect.gen(function* () {
      const api = yield* QueueApi;
      yield* send();
      yield* send();
      const a = yield* api.receive(topic, group, { limit: ReceiveLimit.make(10) });
      const b = yield* api.receive(topic, ConsumerGroupName.make("audit"), {
        limit: ReceiveLimit.make(10),
      });
      assert.strictEqual(a.length, 2);
      assert.strictEqual(b.length, 2);
    }).pipe(Effect.provide(TestQueue.layer)),
  );

  it.effect("answers receiveById with 404, 409 and 410 like the service", () =>
    Effect.gen(function* () {
      const api = yield* QueueApi;
      const missing = yield* api
        .receiveById(topic, group, MessageId.make("msg_x"))
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "MessageNotFound");

      const id = yield* send();
      const leased = yield* api.receiveById(topic, group, id, { visibilityTimeout: "1 minute" });
      const locked = yield* api.receiveById(topic, group, id).pipe(Effect.flip);
      assert.strictEqual(locked._tag, "MessageNotAvailable");
      assert.isTrue(
        Predicate.isTagged(locked, "MessageNotAvailable") &&
          Predicate.isTagged(locked.reason, "MessageLocked"),
      );

      yield* api.acknowledge(leased.handle);
      const done = yield* api.receiveById(topic, group, id).pipe(Effect.flip);
      assert.strictEqual(done._tag, "MessageAlreadyProcessed");
    }).pipe(Effect.provide(TestQueue.layer)),
  );

  it.effect("releases the lease with a zero visibility timeout and counts handoffs", () =>
    Effect.gen(function* () {
      const api = yield* QueueApi;
      yield* send();
      const leased = yield* receiveOne();
      const outcome = yield* api.changeVisibility(leased.handle, Duration.zero, {
        experimentalHandoff: true,
      });
      assert.deepStrictEqual(outcome, Option.some("accepted"));
      const again = yield* receiveOne();
      assert.strictEqual(again.metadata.deliveryCount, 2);
      assert.strictEqual(again.metadata.experimentalHandoffCount, 1);
    }).pipe(Effect.provide(TestQueue.layer)),
  );

  it.effect("extends a lease with changeVisibility", () =>
    Effect.gen(function* () {
      const api = yield* QueueApi;
      yield* send();
      const leased = yield* receiveOne("30 seconds");
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(yield* api.changeVisibility(leased.handle, "1 minute"), Option.none());
      yield* TestClock.adjust("30 seconds");
      yield* api.acknowledge(leased.handle);
    }).pipe(Effect.provide(TestQueue.layer)),
  );

  it.effect("honors delays, retention and idempotency keys", () =>
    Effect.gen(function* () {
      const api = yield* QueueApi;
      const first = yield* send({ idempotencyKey: "k" });
      assert.strictEqual(yield* send({ idempotencyKey: "k" }), first);
      yield* send({ delay: "1 minute" });
      assert.strictEqual(
        (yield* api.receive(topic, group, {
          limit: ReceiveLimit.make(10),
          visibilityTimeout: "10 minutes",
        })).length,
        1,
      );
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(
        (yield* api.receive(topic, group, { limit: ReceiveLimit.make(10) })).length,
        1,
      );
      yield* TestClock.adjust("24 hours");
      const expired = yield* api.receiveById(topic, group, first).pipe(Effect.flip);
      assert.strictEqual(expired._tag, "MessageNotFound");
    }).pipe(Effect.provide(TestQueue.layer)),
  );

  it.effect("records calls with their region and replays scripted failures", () =>
    Effect.gen(function* () {
      const api = yield* QueueApi;
      const queue = yield* TestQueue;
      const lhr1 = VercelRegion.make("lhr1");
      yield* api.receive(topic, group, { region: lhr1 });
      const handle = new MessageHandle({
        topic,
        consumerGroup: group,
        messageId: MessageId.make("msg_1"),
        receiptHandle: ReceiptHandle.make("rh_1"),
        region: lhr1,
      });
      const failure = yield* api.acknowledge(handle).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MessageNotFound");
      const calls = yield* queue.calls;
      assert.deepStrictEqual(
        calls.map((call) => [call.operation, call.region]),
        [
          ["receive", lhr1],
          ["acknowledge", lhr1],
        ],
      );
    }).pipe(Effect.provide(TestQueue.layer)),
  );

  it.effect("refuses acknowledgments that do not cover coalesced messages", () =>
    Effect.gen(function* () {
      const api = yield* QueueApi;
      const queue = yield* TestQueue;
      const id = yield* send();
      const leased = yield* receiveOne();
      yield* queue.coalesce(topic, group, id, 2);
      const refused = yield* api.acknowledge(leased.handle).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "MessageNotAvailable");
      yield* api.acknowledge(leased.handle, { experimentalIfCoalesced: 2 });
    }).pipe(Effect.provide(TestQueue.layer)),
  );
});
