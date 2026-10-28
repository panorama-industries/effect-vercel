import type { HttpServerError } from "effect/http";

import { Cause, Effect, Layer, Option, Predicate } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import type { ConsumeOptions, MessageHandler } from "../contracts/message-handling.ts";
import type { QueueReceiveByIdError } from "../contracts/queue-api.ts";
import type { MessageId } from "../contracts/queue-domain.ts";
import type { Topic } from "../contracts/topic.ts";
import type { Delivery } from "../internal/process.ts";

import { QueueApi } from "../contracts/queue-api.ts";
import { QueueConfig } from "../contracts/queue-config.ts";
import { QueueConsumer } from "../contracts/queue-consumer.ts";
import { inlineDelivery, MalformedCloudEvent, parseCallback } from "../internal/cloud-event.ts";
import { leaseVisibilityTimeout } from "../internal/lease.ts";
import { processDelivery, producerLinks, withProcessSpan } from "../internal/process.ts";

const skipped = (reason: "already_processed" | "not_available", messageId: MessageId) =>
  Effect.logDebug(
    `Queue callback skipped (${reason}) for message ${messageId}: ` +
      "the message was already handled or is no longer available to this consumer.",
  ).pipe(Effect.as(HttpServerResponse.jsonUnsafe({ status: "skipped", reason, messageId })));

const failed = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(cause as Cause.Cause<never>)
    : Effect.logError("Queue callback error", cause).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            { error: "Failed to process queue message" },
            { status: 500 },
          ),
        ),
      );

/**
 * Implements {@link QueueConsumer} for push delivery, as `@vercel/queue`'s `handleCallback`.
 *
 * Requires `QueueApi` and `QueueConfig`. Leases default to 5 minutes (at least 30 seconds) and are
 * renewed while the handler runs. Responses: 200 `{status:"success"}`; 200 `{status:"skipped"}`
 * when the message was already processed (410) or is held elsewhere (409); 400 `{error}` for a
 * malformed CloudEvent; 500 otherwise, so the queue redelivers.
 */
export const QueueConsumerLive = Layer.effect(
  QueueConsumer,
  Effect.gen(function* () {
    const api = yield* QueueApi;
    const config = yield* QueueConfig;

    const handler = <A, I, E, R, R2 = never>(
      topic: Topic<A, I>,
      handle: MessageHandler<A, E, R>,
      options: ConsumeOptions<E, R2> = {},
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const parsed = yield* parseCallback(request.headers, request.text);
        const region = Option.getOrElse(parsed.region, () => config.region);

        const delivery: Effect.Effect<
          Delivery,
          QueueReceiveByIdError | HttpServerError.HttpServerError | MalformedCloudEvent
        > = Option.match(parsed.inline, {
          onNone: () =>
            api
              .receiveById(parsed.topic, parsed.consumerGroup, parsed.messageId, {
                visibilityTimeout: leaseVisibilityTimeout(options.visibilityTimeout),
                region,
              })
              .pipe(Effect.map((message) => ({ message, deadline: Option.none() }))),
          onSome: (inline) =>
            Effect.flatMap(request.arrayBuffer, (buffer) =>
              buffer.byteLength === 0
                ? Effect.fail(
                    new MalformedCloudEvent({
                      message: "Binary mode callback with receipt handle is missing payload",
                    }),
                  )
                : inlineDelivery(parsed, inline, region, topic.contentType, new Uint8Array(buffer)),
            ),
        });

        return yield* delivery.pipe(
          Effect.flatMap((received) => processDelivery(api, topic, handle, options, received)),
          withProcessSpan(producerLinks(request.headers)),
          Effect.as(HttpServerResponse.jsonUnsafe({ status: "success" })),
          Effect.catch((error) => {
            if (Predicate.isTagged(error, "MessageAlreadyProcessed")) {
              return skipped("already_processed", parsed.messageId);
            }
            if (Predicate.isTagged(error, "MessageNotAvailable")) {
              return skipped("not_available", parsed.messageId);
            }
            return Effect.fail(error);
          }),
        );
      }).pipe(
        Effect.catch((error) =>
          error instanceof MalformedCloudEvent
            ? Effect.logError("Queue callback error", error).pipe(
                Effect.as(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 })),
              )
            : Effect.fail(error),
        ),
        Effect.catchCause(failed),
        Effect.annotateLogs({ module: "QueueConsumer" }),
      );

    return QueueConsumer.of({ handler });
  }),
);
