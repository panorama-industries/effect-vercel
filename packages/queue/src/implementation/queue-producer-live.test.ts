import type { Tracer } from "effect";

import { assert, describe, it } from "@effect/vitest";
import { Array, Duration, Effect, Exit, Layer, Match, Option, Schema } from "effect";

import type { OutgoingMessage } from "../contracts/queue-api.ts";
import type { TopicName } from "../contracts/queue-domain.ts";

import { BatchSendResult, QueueApi, SendResult } from "../contracts/queue-api.ts";
import {
  BatchSizeOutOfRange,
  ConcurrencyKey,
  ConsumerDiscoveryFailed,
  IdempotencyKey,
  MessageId,
  PayloadEncodeFailed,
} from "../contracts/queue-domain.ts";
import { QueueProducer } from "../contracts/queue-producer.ts";
import { Topic } from "../contracts/topic.ts";
import { QueueProducerLive } from "./queue-producer-live.ts";

interface Publish {
  readonly topic: TopicName;
  readonly messages: ReadonlyArray<OutgoingMessage>;
  readonly batch: boolean;
  readonly span: Option.Option<Tracer.Span>;
}

type Reply = "sent" | "deferred" | "discovery-failed";

/**
 * A publishing-only QueueApi that records each request and answers it like the queue would. The
 * producer never consumes, so consumer operations are defects here.
 */
const recordingQueueApi = (reply: Reply = "sent") => {
  const published: Array<Publish> = [];
  let nextId = 0;
  const messageId = () => MessageId.make(`msg_${++nextId}`);
  const answer = () =>
    reply === "deferred" ? SendResult.Deferred() : SendResult.Sent({ messageId: messageId() });
  const answerEntry = () =>
    reply === "deferred"
      ? BatchSendResult.Deferred()
      : BatchSendResult.Sent({ messageId: messageId() });
  const record = (topic: TopicName, messages: ReadonlyArray<OutgoingMessage>, batch: boolean) =>
    Effect.gen(function* () {
      const span = yield* Effect.option(Effect.currentSpan);
      published.push({ topic, messages, batch, span });
      if (reply === "discovery-failed") {
        return yield* new ConsumerDiscoveryFailed({ message: "deployment gone" });
      }
    });
  const notPublishing = Effect.die("QueueProducer must only publish");
  const layer = Layer.succeed(
    QueueApi,
    QueueApi.of({
      send: (topic, message) => Effect.map(record(topic, [message], false), answer),
      sendBatch: (topic, messages) =>
        Effect.map(record(topic, messages, true), () => Array.map(messages, answerEntry)),
      receive: () => notPublishing,
      receiveById: () => notPublishing,
      acknowledge: () => notPublishing,
      changeVisibility: () => notPublishing,
    }),
  );
  return { published, layer: QueueProducerLive.pipe(Layer.provide(layer)) };
};

class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  quantity: Schema.Int,
}) {}

const orders = Topic.json("orders", Order);
const strictCounts = Topic.json("counts", Schema.Struct({ count: Schema.Int }));
const thumbnails = Topic.bytes("thumbnails");

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("QueueProducerLive", () => {
  it.effect("encodes the payload with the topic and maps publish options", () => {
    const api = recordingQueueApi();
    return Effect.gen(function* () {
      const producer = yield* QueueProducer;
      const result = yield* producer.send(orders, new Order({ id: "ord_1", quantity: 2 }), {
        idempotencyKey: IdempotencyKey.make("order-1"),
        retention: Duration.hours(2),
        delay: "30 seconds",
        headers: { "x-tenant": "acme" },
        experimentalConcurrencyKey: ConcurrencyKey.make("acme"),
      });

      assert.deepStrictEqual(result, SendResult.Sent({ messageId: MessageId.make("msg_1") }));
      const [publish] = api.published;
      assert.isDefined(publish);
      assert.strictEqual(publish.topic, "orders");
      assert.isFalse(publish.batch);
      const [message] = publish.messages;
      assert.isDefined(message);
      assert.strictEqual(text(message.body), '{"id":"ord_1","quantity":2}');
      assert.deepStrictEqual(
        { ...message, body: undefined },
        {
          body: undefined,
          contentType: "application/json",
          idempotencyKey: IdempotencyKey.make("order-1"),
          retention: Duration.hours(2),
          delay: "30 seconds",
          headers: { "x-tenant": "acme" },
          experimentalConcurrencyKey: ConcurrencyKey.make("acme"),
        },
      );
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("sends only body and content type without options", () => {
    const api = recordingQueueApi();
    return Effect.gen(function* () {
      const producer = yield* QueueProducer;
      const bytes = new Uint8Array([0, 1, 255]);
      yield* producer.send(thumbnails, bytes);

      const message = api.published[0]?.messages[0];
      assert.deepStrictEqual(Object.keys(message ?? {}).sort(), ["body", "contentType"]);
      assert.strictEqual(message?.contentType, "application/octet-stream");
      assert.deepStrictEqual(message?.body, bytes);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("fails with PayloadEncodeFailed before publishing an invalid payload", () => {
    const api = recordingQueueApi();
    return Effect.gen(function* () {
      const producer = yield* QueueProducer;
      const error = yield* Effect.flip(producer.send(strictCounts, { count: 1.5 }));
      assert.instanceOf(error, PayloadEncodeFailed);
      assert.strictEqual(error.topic, "counts");
      assert.deepStrictEqual(api.published, []);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("publishes inside a vqs.send producer span with the message ID", () => {
    const api = recordingQueueApi();
    return Effect.gen(function* () {
      const producer = yield* QueueProducer;
      const parent = yield* Effect.currentSpan;
      yield* producer.send(orders, new Order({ id: "ord_1", quantity: 1 }));

      const span = Option.getOrThrow(api.published[0]!.span);
      assert.strictEqual(span.name, "vqs.send");
      assert.strictEqual(span.kind, "producer");
      assert.deepStrictEqual(
        Option.map(span.parent, (p) => p.spanId),
        Option.some(parent.spanId),
      );
      assert.deepStrictEqual(Object.fromEntries(span.attributes), {
        "messaging.system": "vercel-queue",
        "messaging.destination.name": "orders",
        "messaging.message.id": "msg_1",
      });
      assert.strictEqual(span.status._tag, "Ended");
    }).pipe(Effect.withSpan("caller"), Effect.provide(api.layer));
  });

  it.effect("records no message ID for a deferred send", () => {
    const api = recordingQueueApi("deferred");
    return Effect.gen(function* () {
      const producer = yield* QueueProducer;
      const result = yield* producer.send(orders, new Order({ id: "ord_1", quantity: 1 }));
      assert.deepStrictEqual(result, SendResult.Deferred());
      const span = Option.getOrThrow(api.published[0]!.span);
      assert.isFalse(span.attributes.has("messaging.message.id"));
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("passes queue failures through and ends the span with them", () => {
    const api = recordingQueueApi("discovery-failed");
    return Effect.gen(function* () {
      const producer = yield* QueueProducer;
      const error = yield* Effect.flip(
        producer.send(orders, new Order({ id: "ord_1", quantity: 1 })),
      );
      assert.strictEqual(error._tag, "ConsumerDiscoveryFailed");
      const span = Option.getOrThrow(api.published[0]!.span);
      const failed = Match.value(span.status).pipe(
        Match.tag("Ended", (status) => Exit.isFailure(status.exit)),
        Match.orElse(() => false),
      );
      assert.isTrue(failed);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("sendBatch encodes every entry in order with its own options", () => {
    const api = recordingQueueApi();
    return Effect.gen(function* () {
      const producer = yield* QueueProducer;
      const results = yield* producer.sendBatch(orders, [
        { payload: new Order({ id: "a", quantity: 1 }) },
        {
          payload: new Order({ id: "b", quantity: 2 }),
          idempotencyKey: IdempotencyKey.make("b"),
          delay: Duration.minutes(1),
        },
      ]);

      assert.deepStrictEqual(results, [
        BatchSendResult.Sent({ messageId: MessageId.make("msg_1") }),
        BatchSendResult.Sent({ messageId: MessageId.make("msg_2") }),
      ]);
      assert.strictEqual(api.published.length, 1);
      const publish = api.published[0]!;
      assert.isTrue(publish.batch);
      assert.deepStrictEqual(
        publish.messages.map((message) => ({ ...message, body: text(message.body) })),
        [
          { body: '{"id":"a","quantity":1}', contentType: "application/json" },
          {
            body: '{"id":"b","quantity":2}',
            contentType: "application/json",
            idempotencyKey: IdempotencyKey.make("b"),
            delay: Duration.minutes(1),
          },
        ],
      );
      const span = Option.getOrThrow(publish.span);
      assert.strictEqual(span.name, "vqs.send");
      assert.strictEqual(span.kind, "producer");
      assert.strictEqual(span.attributes.get("messaging.destination.name"), "orders");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect(
    "sendBatch accepts 100 entries and rejects 101 with BatchSizeOutOfRange without publishing",
    () => {
      const api = recordingQueueApi();
      return Effect.gen(function* () {
        const producer = yield* QueueProducer;
        const entry = { payload: new Uint8Array([1]) };
        const hundred = Array.replicate(entry, 100);
        const results = yield* producer.sendBatch(thumbnails, hundred);
        assert.strictEqual(results.length, 100);

        const error = yield* Effect.flip(
          producer.sendBatch(thumbnails, Array.replicate(entry, 101)),
        );
        assert.deepStrictEqual(error, new BatchSizeOutOfRange({ size: 101, maximum: 100 }));
        assert.strictEqual(api.published.length, 1);
      }).pipe(Effect.provide(api.layer));
    },
  );

  it.effect("sendBatch publishes nothing when any entry fails to encode", () => {
    const api = recordingQueueApi();
    return Effect.gen(function* () {
      const producer = yield* QueueProducer;
      const error = yield* Effect.flip(
        producer.sendBatch(strictCounts, [{ payload: { count: 1 } }, { payload: { count: 0.5 } }]),
      );
      assert.strictEqual(error._tag, "PayloadEncodeFailed");
      assert.deepStrictEqual(api.published, []);
    }).pipe(Effect.provide(api.layer));
  });
});
