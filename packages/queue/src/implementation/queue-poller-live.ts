import { Effect, Exit, Layer, Option, Predicate, Scope } from "effect";

import type { ConsumeOptions, MessageHandler } from "../contracts/message-handling.ts";
import type {
  ConsumerGroupName,
  MessageAlreadyProcessed,
  MessageId,
  MessageNotAvailable,
  MessageNotFound,
  ReceivedMessage,
} from "../contracts/queue-domain.ts";
import type { PollByIdOptions, PollOptions } from "../contracts/queue-poller.ts";
import type { Topic } from "../contracts/topic.ts";

import { QueueApi } from "../contracts/queue-api.ts";
import { MessageCorrupted, PayloadDecodeFailed } from "../contracts/queue-domain.ts";
import { QueuePoller, ReceiveOutcome } from "../contracts/queue-poller.ts";
import { keepLeaseAlive, leaseVisibilityTimeout } from "../internal/lease.ts";
import { processDelivery, withProcessSpan } from "../internal/process.ts";

/**
 * Implements {@link QueuePoller}, as `@vercel/queue`'s `PollingQueueClient.receive`.
 *
 * Requires `QueueApi`. Leases default to 5 minutes (at least 30 seconds) and are renewed while each
 * handler runs. A batch is handled concurrently up to `concurrency` (unbounded by default), and
 * messages waiting their turn keep their leases renewed. When handlers fail, every message is still
 * settled and the first failure in delivery order is returned. An undecodable payload whose error
 * policy answers `Fail` is reported as `MessageCorrupted`.
 */
export const QueuePollerLive = Layer.effect(
  QueuePoller,
  Effect.gen(function* () {
    const api = yield* QueueApi;

    const handleOne = <A, I, E, R, R2>(
      topic: Topic<A, I>,
      handler: MessageHandler<A, E, R>,
      options: ConsumeOptions<E, R2>,
      message: ReceivedMessage,
    ) =>
      processDelivery(api, topic, handler, options, {
        message,
        deadline: Option.none(),
      }).pipe(
        withProcessSpan([]),
        Effect.mapError((error) =>
          error instanceof PayloadDecodeFailed
            ? new MessageCorrupted({ messageId: error.messageId, message: error.message })
            : error,
        ),
      );

    const receive = <A, I, E, R, R2 = never>(
      topic: Topic<A, I>,
      consumerGroup: ConsumerGroupName,
      handler: MessageHandler<A, E, R>,
      options: PollOptions<E, R2> = {},
    ) =>
      Effect.gen(function* () {
        const messages = yield* api.receive(topic.name, consumerGroup, {
          visibilityTimeout: leaseVisibilityTimeout(options.visibilityTimeout),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.cursorFallback === undefined
            ? {}
            : { cursorFallback: options.cursorFallback }),
          ...(options.region === undefined ? {} : { region: options.region }),
        });
        if (messages.length === 0) return ReceiveOutcome.Empty();
        const timeout = leaseVisibilityTimeout(options.visibilityTimeout);
        const waiting = yield* Effect.forEach(messages, (message) =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            yield* keepLeaseAlive(api, message.handle, timeout, Option.none()).pipe(
              Scope.provide(scope),
            );
            return { message, scope };
          }),
        );
        const exits = yield* Effect.forEach(
          waiting,
          ({ message, scope }) =>
            Scope.close(scope, Exit.void).pipe(
              Effect.andThen(Effect.exit(handleOne(topic, handler, options, message))),
            ),
          { concurrency: options.concurrency ?? "unbounded" },
        ).pipe(
          Effect.ensuring(Effect.forEach(waiting, ({ scope }) => Scope.close(scope, Exit.void))),
        );
        const failure = exits.find(Exit.isFailure);
        if (failure !== undefined) return yield* Effect.failCause(failure.cause);
        return ReceiveOutcome.Processed({ count: messages.length });
      });

    const receiveById = <A, I, E, R, R2 = never>(
      topic: Topic<A, I>,
      consumerGroup: ConsumerGroupName,
      messageId: MessageId,
      handler: MessageHandler<A, E, R>,
      options: PollByIdOptions<E, R2> = {},
    ) =>
      api
        .receiveById(topic.name, consumerGroup, messageId, {
          visibilityTimeout: leaseVisibilityTimeout(options.visibilityTimeout),
          ...(options.region === undefined ? {} : { region: options.region }),
        })
        .pipe(
          Effect.flatMap((message) => handleOne(topic, handler, options, message)),
          Effect.as(ReceiveOutcome.Processed({ count: 1 })),
          Effect.catch((error) => {
            if (Predicate.isTagged(error, "MessageNotFound")) {
              return Effect.succeed<ReceiveOutcome>(ReceiveOutcome.NotFound({ messageId }));
            }
            if (Predicate.isTagged(error, "MessageNotAvailable")) {
              return Effect.succeed<ReceiveOutcome>(ReceiveOutcome.NotAvailable({ messageId }));
            }
            if (Predicate.isTagged(error, "MessageAlreadyProcessed")) {
              return Effect.succeed<ReceiveOutcome>(ReceiveOutcome.AlreadyProcessed({ messageId }));
            }
            return Effect.fail(
              error as Exclude<
                typeof error,
                MessageNotFound | MessageNotAvailable | MessageAlreadyProcessed
              >,
            );
          }),
        );

    return QueuePoller.of({ receive, receiveById });
  }),
);
