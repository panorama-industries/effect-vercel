import { Array, Effect, Layer, Schema } from "effect";

import type { PublishOptions } from "../contracts/queue-api.ts";
import type { BatchEntry } from "../contracts/queue-producer.ts";
import type { Topic } from "../contracts/topic.ts";

import { QueueApi, SendResult } from "../contracts/queue-api.ts";
import { BatchSizeOutOfRange, PayloadEncodeFailed } from "../contracts/queue-domain.ts";
import { QueueProducer } from "../contracts/queue-producer.ts";

const maxBatchSize = 100;

const encode = <A, I>(topic: Topic<A, I>, payload: A) =>
  Schema.encodeEffect(topic.wire)(payload).pipe(
    Effect.mapError(
      (error) => new PayloadEncodeFailed({ topic: topic.name, message: error.message }),
    ),
  );

const publishOptions = (options: PublishOptions): PublishOptions => ({
  ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
  ...(options.retention !== undefined && { retention: options.retention }),
  ...(options.delay !== undefined && { delay: options.delay }),
  ...(options.headers !== undefined && { headers: options.headers }),
  ...(options.experimentalConcurrencyKey !== undefined && {
    experimentalConcurrencyKey: options.experimentalConcurrencyKey,
  }),
});

const sendSpan = (topic: Topic.Any) =>
  Effect.withSpan("vqs.send", {
    kind: "producer",
    attributes: {
      "messaging.system": "vercel-queue",
      "messaging.destination.name": topic.name,
    },
  });

/**
 * Implements {@link QueueProducer} over `QueueApi`: encodes payloads with the topic's schema and
 * publishes them in a `vqs.send` producer span.
 */
export const QueueProducerLive: Layer.Layer<QueueProducer, never, QueueApi> = Layer.effect(
  QueueProducer,
  Effect.gen(function* () {
    const api = yield* QueueApi;

    const send = Effect.fnUntraced(function* <A, I>(
      topic: Topic<A, I>,
      payload: A,
      options: PublishOptions = {},
    ) {
      const body = yield* encode(topic, payload);
      return yield* api
        .send(topic.name, { ...publishOptions(options), body, contentType: topic.contentType })
        .pipe(
          Effect.tap(
            SendResult.$match({
              Sent: ({ messageId }) =>
                Effect.annotateCurrentSpan("messaging.message.id", messageId),
              Deferred: () => Effect.void,
            }),
          ),
          sendSpan(topic),
        );
    });

    const sendBatch = Effect.fnUntraced(function* <A, I>(
      topic: Topic<A, I>,
      entries: Array.NonEmptyReadonlyArray<BatchEntry<A>>,
    ) {
      if (entries.length === 0 || entries.length > maxBatchSize) {
        return yield* new BatchSizeOutOfRange({ size: entries.length, maximum: maxBatchSize });
      }
      const toMessage = (entry: BatchEntry<A>) =>
        Effect.map(encode(topic, entry.payload), (body) => ({
          ...publishOptions(entry),
          body,
          contentType: topic.contentType,
        }));
      const [head, ...tail] = entries;
      const first = yield* toMessage(head);
      const rest = yield* Effect.forEach(tail, toMessage);
      return yield* api.sendBatch(topic.name, [first, ...rest]).pipe(sendSpan(topic));
    });

    return QueueProducer.of({ send, sendBatch });
  }),
);
