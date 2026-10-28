import { VercelRegion } from "@panorama-industries/effect-vercel-core";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option } from "effect";

import type {
  OutgoingMessage,
  QueueLeaseError,
  QueueReceiveByIdError,
  QueueRequestError,
  QueueSendError,
  ReceiveByIdOptions,
  ReceiveOptions,
} from "../contracts/queue-api.ts";

import { BatchSendResult, QueueApi, SendResult } from "../contracts/queue-api.ts";
import {
  ConcurrencyCoalescedPending,
  ConsumerGroupName,
  CursorFallback,
  MessageAlreadyProcessed,
  MessageCorrupted,
  MessageHandle,
  MessageId,
  MessageLocked,
  MessageMetadata,
  MessageNotAvailable,
  MessageNotFound,
  MessageUnavailable,
  ReceiptHandle,
  ReceivedMessage,
  TopicName,
} from "../contracts/queue-domain.ts";

/** A `QueueApi` operation, as recorded by {@link TestQueue}. */
export type TestQueueOperation =
  | "send"
  | "sendBatch"
  | "receive"
  | "receiveById"
  | "acknowledge"
  | "changeVisibility";

/** Errors each operation can be scripted to fail with. */
export interface TestQueueOperationError {
  readonly send: QueueSendError;
  readonly sendBatch: QueueSendError;
  readonly receive: QueueRequestError | MessageCorrupted;
  readonly receiveById: QueueReceiveByIdError;
  readonly acknowledge: QueueLeaseError;
  readonly changeVisibility: QueueLeaseError;
}

/** One call made to the test `QueueApi`, in call order. */
export interface TestQueueCall {
  readonly operation: TestQueueOperation;
  /** When the call was made, in epoch milliseconds. */
  readonly at: number;
  readonly topic: TopicName;
  /** Region the call was routed to: the handle's region for lease calls. */
  readonly region: VercelRegion;
  readonly consumerGroup?: ConsumerGroupName;
  readonly messageId?: MessageId;
  readonly receiptHandle?: ReceiptHandle;
  readonly visibilityTimeout?: Duration.Duration;
  readonly limit?: number;
  readonly cursorFallback?: CursorFallback;
  readonly experimentalHandoff?: boolean;
  readonly experimentalIfCoalesced?: number;
}

/** Where one message stands for one consumer group. */
export interface TestQueueDelivery {
  readonly status: "pending" | "leased" | "acknowledged";
  readonly deliveryCount: number;
  readonly handoffCount: number;
  /** When the message becomes receivable again, in epoch milliseconds. */
  readonly visibleAt: number;
  readonly receiptHandle: Option.Option<ReceiptHandle>;
  readonly coalescedCount: number;
}

interface StoredMessage {
  readonly id: MessageId;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly availableAt: number;
  readonly idempotencyKey: string | undefined;
}

interface MutableDelivery {
  status: TestQueueDelivery["status"];
  deliveryCount: number;
  handoffCount: number;
  visibleAt: number;
  receiptHandle: Option.Option<ReceiptHandle>;
  coalescedCount: number;
}

const DEFAULT_RETENTION = Duration.hours(24);
const DEFAULT_VISIBILITY_TIMEOUT = Duration.seconds(30);

/**
 * Inspects and scripts the in-memory queue behind {@link TestQueue.layer}.
 *
 * Time follows `Clock`, so `TestClock` drives lease expiry and delays.
 */
export class TestQueue extends Context.Service<
  TestQueue,
  {
    /** Every `QueueApi` call so far, in order, including calls that failed. */
    readonly calls: Effect.Effect<ReadonlyArray<TestQueueCall>>;

    /** The state of one message for one consumer group; none before it was first leased. */
    readonly delivery: (
      topic: TopicName,
      consumerGroup: ConsumerGroupName,
      messageId: MessageId,
    ) => Effect.Effect<Option.Option<TestQueueDelivery>>;

    /** Make the next call to `operation` fail with `error` instead of running. */
    readonly failNext: <Op extends TestQueueOperation>(
      operation: Op,
      error: TestQueueOperationError[Op],
    ) => Effect.Effect<void>;

    /**
     * **Experimental.** Coalesce `count` messages into the current delivery, as a concurrency key
     * does: acknowledgments are refused with `ConcurrencyCoalescedPending` until they cover it.
     */
    readonly coalesce: (
      topic: TopicName,
      consumerGroup: ConsumerGroupName,
      messageId: MessageId,
      count: number,
    ) => Effect.Effect<void>;
  }
>()("@effect-vercel/queue/TestQueue") {
  /**
   * An in-memory `QueueApi` with real lease semantics, plus the {@link TestQueue} controls.
   *
   * Each consumer group sees every message of a topic. Leases expire after their visibility
   * timeout; acknowledging or changing visibility needs the current receipt handle (409 otherwise,
   * 404 once acknowledged). Leasing by identifier answers 404, 409 or 410 like the service.
   * Calls without a region go to `iad1`.
   */
  static readonly layer: Layer.Layer<QueueApi | TestQueue> = Layer.effectContext(
    Effect.sync(() => {
      const defaultRegion = VercelRegion.make("iad1");
      const topics = new Map<TopicName, Array<StoredMessage>>();
      const deliveries = new Map<string, MutableDelivery>();
      const recorded: Array<TestQueueCall> = [];
      const scripted = new Map<TestQueueOperation, Array<unknown>>();
      let sequence = 0;

      const key = (topic: string, group: string, id: string) => `${topic}\u0000${group}\u0000${id}`;
      const nextId = (prefix: string) => `${prefix}_${++sequence}`;

      const call = <Op extends TestQueueOperation, A>(
        entry: Omit<TestQueueCall, "at"> & { readonly operation: Op },
        run: (now: number) => Effect.Effect<A, TestQueueOperationError[Op]>,
      ): Effect.Effect<A, TestQueueOperationError[Op]> =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => {
          recorded.push({ ...entry, at: now });
          const failure = scripted.get(entry.operation)?.shift();
          if (failure !== undefined) {
            return Effect.fail(failure as TestQueueOperationError[Op]);
          }
          return run(now);
        });

      const findMessage = (topic: TopicName, id: string, now: number) =>
        Option.fromNullishOr(
          topics.get(topic)?.find((message) => message.id === id && message.expiresAt > now),
        );

      const deliveryOf = (topic: TopicName, group: ConsumerGroupName, id: MessageId) => {
        const k = key(topic, group, id);
        let state = deliveries.get(k);
        if (state === undefined) {
          state = {
            status: "pending",
            deliveryCount: 0,
            handoffCount: 0,
            visibleAt: 0,
            receiptHandle: Option.none(),
            coalescedCount: 0,
          };
          deliveries.set(k, state);
        }
        return state;
      };

      const isLeased = (state: MutableDelivery, now: number) =>
        state.status === "leased" && state.visibleAt > now;

      const lease = (
        topic: TopicName,
        group: ConsumerGroupName,
        message: StoredMessage,
        state: MutableDelivery,
        now: number,
        timeout: Duration.Duration,
        region: VercelRegion,
      ) => {
        const receiptHandle = ReceiptHandle.make(nextId("rh"));
        state.status = "leased";
        state.deliveryCount += 1;
        state.visibleAt = now + Duration.toMillis(timeout);
        state.receiptHandle = Option.some(receiptHandle);
        return new ReceivedMessage({
          handle: new MessageHandle({
            topic,
            consumerGroup: group,
            messageId: message.id,
            receiptHandle,
            region,
          }),
          metadata: new MessageMetadata({
            messageId: message.id,
            deliveryCount: state.deliveryCount,
            createdAt: DateTime.makeUnsafe(message.createdAt),
            expiresAt: DateTime.makeUnsafe(message.expiresAt),
            topic,
            consumerGroup: group,
            region,
            ...(state.handoffCount > 0 ? { experimentalHandoffCount: state.handoffCount } : {}),
          }),
          contentType: message.contentType,
          body: message.body,
        });
      };

      const publish = (topic: TopicName, message: OutgoingMessage, now: number) => {
        const stored = topics.get(topic) ?? [];
        topics.set(topic, stored);
        if (message.idempotencyKey !== undefined) {
          const duplicate = stored.find(
            (existing) =>
              existing.idempotencyKey === message.idempotencyKey && existing.expiresAt > now,
          );
          if (duplicate !== undefined) return duplicate.id;
        }
        const id = MessageId.make(nextId("msg"));
        const retention =
          message.retention === undefined
            ? DEFAULT_RETENTION
            : Duration.fromInputUnsafe(message.retention);
        stored.push({
          id,
          body: message.body,
          contentType: message.contentType,
          createdAt: now,
          expiresAt: now + Duration.toMillis(retention),
          availableAt: now + (message.delay === undefined ? 0 : Duration.toMillis(message.delay)),
          idempotencyKey: message.idempotencyKey,
        });
        return id;
      };

      const validateLease = (
        handle: MessageHandle,
        now: number,
      ): Effect.Effect<MutableDelivery, MessageNotFound | MessageNotAvailable> => {
        const message = findMessage(handle.topic, handle.messageId, now);
        const state = deliveries.get(key(handle.topic, handle.consumerGroup, handle.messageId));
        if (Option.isNone(message) || state === undefined || state.status === "acknowledged") {
          return Effect.fail(new MessageNotFound({ messageId: handle.messageId }));
        }
        const held =
          isLeased(state, now) &&
          Option.getOrUndefined(state.receiptHandle) === handle.receiptHandle;
        if (!held) {
          return Effect.fail(
            new MessageNotAvailable({
              messageId: handle.messageId,
              reason: new MessageUnavailable({ message: "The lease is no longer held" }),
            }),
          );
        }
        return Effect.succeed(state);
      };

      const api = QueueApi.of({
        send: (topic, message) =>
          call({ operation: "send", topic, region: defaultRegion }, (now) =>
            Effect.succeed(SendResult.Sent({ messageId: publish(topic, message, now) })),
          ),

        sendBatch: (topic, messages) =>
          call({ operation: "sendBatch", topic, region: defaultRegion }, (now) =>
            Effect.succeed(
              messages.map((message) =>
                BatchSendResult.Sent({ messageId: publish(topic, message, now) }),
              ),
            ),
          ),

        receive: (topic, consumerGroup, options?: ReceiveOptions) => {
          const region = options?.region ?? defaultRegion;
          const timeout = Duration.fromInputUnsafe(
            options?.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT,
          );
          const limit = options?.limit ?? 1;
          return call(
            {
              operation: "receive",
              topic,
              region,
              consumerGroup,
              visibilityTimeout: timeout,
              limit,
              ...(options?.cursorFallback === undefined
                ? {}
                : { cursorFallback: options.cursorFallback }),
            },
            (now) =>
              Effect.succeed(
                (topics.get(topic) ?? [])
                  .filter((message) => message.expiresAt > now && message.availableAt <= now)
                  .map((message) => ({
                    message,
                    state: deliveryOf(topic, consumerGroup, message.id),
                  }))
                  .filter(({ state }) => state.status !== "acknowledged" && state.visibleAt <= now)
                  .slice(0, limit)
                  .map(({ message, state }) =>
                    lease(topic, consumerGroup, message, state, now, timeout, region),
                  ),
              ),
          );
        },

        receiveById: (topic, consumerGroup, messageId, options?: ReceiveByIdOptions) => {
          const region = options?.region ?? defaultRegion;
          const timeout = Duration.fromInputUnsafe(
            options?.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT,
          );
          return call(
            {
              operation: "receiveById",
              topic,
              region,
              consumerGroup,
              messageId,
              visibilityTimeout: timeout,
            },
            (now) => {
              const message = findMessage(topic, messageId, now);
              if (Option.isNone(message)) {
                return Effect.fail(new MessageNotFound({ messageId }));
              }
              const state = deliveryOf(topic, consumerGroup, messageId);
              if (state.status === "acknowledged") {
                return Effect.fail(new MessageAlreadyProcessed({ messageId }));
              }
              if (isLeased(state, now)) {
                return Effect.fail(
                  new MessageNotAvailable({
                    messageId,
                    reason: new MessageLocked({
                      retryAfter: Option.some(Duration.millis(state.visibleAt - now)),
                    }),
                  }),
                );
              }
              if (message.value.availableAt > now || state.visibleAt > now) {
                return Effect.fail(
                  new MessageNotAvailable({
                    messageId,
                    reason: new MessageUnavailable({ message: "The message is not visible yet" }),
                  }),
                );
              }
              return Effect.succeed(
                lease(topic, consumerGroup, message.value, state, now, timeout, region),
              );
            },
          );
        },

        acknowledge: (handle, options) =>
          call(
            {
              operation: "acknowledge",
              topic: handle.topic,
              region: handle.region,
              consumerGroup: handle.consumerGroup,
              messageId: handle.messageId,
              receiptHandle: handle.receiptHandle,
              ...(options?.experimentalIfCoalesced === undefined
                ? {}
                : { experimentalIfCoalesced: options.experimentalIfCoalesced }),
            },
            (now) =>
              Effect.flatMap(validateLease(handle, now), (state) => {
                if (state.coalescedCount > (options?.experimentalIfCoalesced ?? 0)) {
                  return Effect.fail(
                    new MessageNotAvailable({
                      messageId: handle.messageId,
                      reason: new ConcurrencyCoalescedPending({
                        coalescedCount: state.coalescedCount,
                      }),
                    }),
                  );
                }
                state.status = "acknowledged";
                state.receiptHandle = Option.none();
                state.coalescedCount = 0;
                return Effect.void;
              }),
          ),

        changeVisibility: (handle, visibilityTimeout, options) => {
          const timeout = Duration.fromInputUnsafe(visibilityTimeout);
          const handoff = options?.experimentalHandoff === true;
          return call(
            {
              operation: "changeVisibility",
              topic: handle.topic,
              region: handle.region,
              consumerGroup: handle.consumerGroup,
              messageId: handle.messageId,
              receiptHandle: handle.receiptHandle,
              visibilityTimeout: timeout,
              ...(handoff ? { experimentalHandoff: true } : {}),
            },
            (now) =>
              Effect.map(validateLease(handle, now), (state) => {
                const releases = Duration.isZero(timeout);
                state.visibleAt = now + Duration.toMillis(timeout);
                if (releases) {
                  state.status = "pending";
                  state.receiptHandle = Option.none();
                }
                if (!handoff) return Option.none();
                if (!releases) return Option.some("not_immediate" as const);
                state.handoffCount += 1;
                return Option.some("accepted" as const);
              }),
          );
        },
      });

      const control = TestQueue.of({
        calls: Effect.sync(() => [...recorded]),
        delivery: (topic, consumerGroup, messageId) =>
          Effect.sync(() =>
            Option.map(
              Option.fromNullishOr(deliveries.get(key(topic, consumerGroup, messageId))),
              (state) => ({ ...state }),
            ),
          ),
        failNext: (operation, error) =>
          Effect.sync(() => {
            const queue = scripted.get(operation) ?? [];
            queue.push(error);
            scripted.set(operation, queue);
          }),
        coalesce: (topic, consumerGroup, messageId, count) =>
          Effect.sync(() => {
            deliveryOf(topic, consumerGroup, messageId).coalescedCount = count;
          }),
      });

      return Context.make(QueueApi, api).pipe(Context.add(TestQueue, control));
    }),
  );
}
