import type { Tracer } from "effect";

import { Duration, Effect, Option, Schema } from "effect";
import { Headers, HttpTraceContext } from "effect/http";

import type {
  ConsumeFailure,
  ConsumeOptions,
  MessageHandler,
} from "../contracts/message-handling.ts";
import type { QueueApi, QueueLeaseError } from "../contracts/queue-api.ts";
import type { ReceivedMessage } from "../contracts/queue-domain.ts";
import type { Topic } from "../contracts/topic.ts";
import type { LeaseDeadline } from "./lease.ts";

import { RetryDirective } from "../contracts/message-handling.ts";
import { MessageMetadata, PayloadDecodeFailed } from "../contracts/queue-domain.ts";
import { keepLeaseAlive, leaseVisibilityTimeout } from "./lease.ts";

export interface Delivery {
  readonly message: ReceivedMessage;
  readonly deadline: LeaseDeadline;
}

/** Errors a processed delivery can end with once its error policy answered `Fail`. */
export type ProcessError<E> = E | PayloadDecodeFailed | QueueLeaseError;

interface Escalation<E> {
  readonly forPolicy: Option.Option<E | ConsumeFailure>;
  readonly error: ProcessError<E>;
}

const escalate = <E>(
  forPolicy: Option.Option<E | ConsumeFailure>,
  error: ProcessError<E>,
): Escalation<E> => ({ forPolicy, error });

const toPolicy = <E>(error: E | PayloadDecodeFailed): Escalation<E> =>
  escalate<E>(Option.some(error), error);

/**
 * Leases, decodes, handles and settles one delivered message, following `@vercel/queue`'s
 * `ConsumerGroup.processMessage`.
 */
export const processDelivery = <A, I, E, R, R2>(
  api: QueueApi["Service"],
  topic: Topic<A, I>,
  handler: MessageHandler<A, E, R>,
  options: ConsumeOptions<E, R2>,
  delivery: Delivery,
): Effect.Effect<void, ProcessError<E>, R | R2> => {
  const { handle, metadata, body } = delivery.message;
  const timeout = leaseVisibilityTimeout(options.visibilityTimeout);
  const maxReruns = Math.max(0, Math.floor(options.experimentalMaxCoalescedReruns ?? 0));

  const decode = Schema.decodeEffect(topic.wire)(body).pipe(
    Effect.mapError(
      (error) =>
        new PayloadDecodeFailed({
          topic: handle.topic,
          messageId: handle.messageId,
          message: error.message,
        }),
    ),
  );

  const runHandler = (payload: A, meta: MessageMetadata, deadline: LeaseDeadline) =>
    Effect.scoped(
      keepLeaseAlive(api, handle, timeout, deadline).pipe(Effect.andThen(handler(payload, meta))),
    ).pipe(Effect.mapError(toPolicy));

  const settleFailure = (error: QueueLeaseError) => Effect.fail(escalate<E>(Option.none(), error));

  const acknowledge = (rerun: number, coalescedCount: number) =>
    api
      .acknowledge(
        handle,
        coalescedCount > 0 ? { experimentalIfCoalesced: coalescedCount } : undefined,
      )
      .pipe(
        Effect.as(Option.none<number>()),
        Effect.catchReason("MessageNotAvailable", "ConcurrencyCoalescedPending", (reason, error) =>
          rerun > maxReruns
            ? Effect.fail(escalate<E>(Option.some(reason), error))
            : Effect.succeed(Option.some(reason.coalescedCount)),
        ),
        Effect.catchTags({
          MessageNotAvailable: settleFailure,
          MessageNotFound: settleFailure,
          VercelApiError: settleFailure,
          ConsumerRegistryNotConfigured: settleFailure,
        }),
      );

  const attempt = Effect.gen(function* () {
    const payload = yield* Effect.mapError(decode, toPolicy);
    yield* runHandler(payload, metadata, delivery.deadline);
    let coalescedCount = 0;
    for (let rerun = 1; ; rerun++) {
      const refused = yield* acknowledge(rerun, coalescedCount);
      if (Option.isNone(refused)) return;
      coalescedCount = refused.value;
      yield* runHandler(
        payload,
        new MessageMetadata({
          messageId: metadata.messageId,
          deliveryCount: metadata.deliveryCount,
          createdAt: metadata.createdAt,
          expiresAt: metadata.expiresAt,
          topic: metadata.topic,
          consumerGroup: metadata.consumerGroup,
          region: metadata.region,
          ...(metadata.experimentalHandoffCount === undefined
            ? {}
            : { experimentalHandoffCount: metadata.experimentalHandoffCount }),
          experimentalCoalesced: { rerun, coalescedCount },
        }),
        Option.some("expired"),
      );
    }
  });

  const chooseDirective = (error: E | ConsumeFailure) =>
    options.onError === undefined
      ? Effect.succeed(RetryDirective.Fail())
      : options
          .onError(error, metadata)
          .pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("Queue error policy failed; failing the delivery", defect).pipe(
                Effect.as(RetryDirective.Fail()),
              ),
            ),
          );

  const applyDirective = (directive: RetryDirective, error: ProcessError<E>) =>
    RetryDirective.$match(directive, {
      Acknowledge: () =>
        api
          .acknowledge(handle)
          .pipe(Effect.catch((cause) => Effect.logWarning("Failed to acknowledge message", cause))),
      RetryAfter: ({ delay }) =>
        api.changeVisibility(handle, delay).pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logWarning("Failed to reschedule message for retry", cause),
          ),
        ),
      ExperimentalHandoff: () =>
        api.changeVisibility(handle, Duration.zero, { experimentalHandoff: true }).pipe(
          Effect.asVoid,
          Effect.catch((cause) => Effect.logWarning("Failed to hand off message", cause)),
        ),
      Fail: () => Effect.fail(error),
    });

  return attempt.pipe(
    Effect.catch(({ forPolicy, error }) =>
      Option.match(forPolicy, {
        onNone: () => Effect.fail(error),
        onSome: (cause) =>
          chooseDirective(cause).pipe(
            Effect.flatMap((directive) => applyDirective(directive, error)),
          ),
      }),
    ),
    Effect.annotateLogs({ module: "QueueConsumer", messageId: handle.messageId }),
  );
};

const PRODUCER_TRACEPARENT = "x-vercel-queue-traceparent";

/** Links the producer's span, delivered in `x-vercel-queue-traceparent`, without parenting to it. */
export const producerLinks = (headers: Headers.Headers): ReadonlyArray<Tracer.SpanLink> => {
  const traceparent = headers[PRODUCER_TRACEPARENT];
  if (!traceparent) return [];
  return Option.match(HttpTraceContext.w3c(Headers.fromInput({ traceparent })), {
    onNone: () => [],
    onSome: (span) => [{ span, attributes: {} }],
  });
};

/** Runs `self` in a consumer-kind `vqs.process` span, as `@vercel/queue`'s `withConsumerSpan`. */
export const withProcessSpan =
  (links: ReadonlyArray<Tracer.SpanLink>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withSpan(self, "vqs.process", {
      kind: "consumer",
      links,
      attributes: {
        "messaging.system": "vercel-queue",
        "messaging.operation": "process",
      },
    });
