import type { VercelApiError, VercelRegion } from "@panorama-industries/effect-vercel-core";
import type { Array, Duration, Effect, Option } from "effect";

import { Context, Data, Schema } from "effect";

import type {
  BatchSizeOutOfRange,
  ConcurrencyKey,
  ConsumerDiscoveryFailed,
  ConsumerGroupName,
  ConsumerRegistryNotConfigured,
  CursorFallback,
  IdempotencyKey,
  MessageAlreadyProcessed,
  MessageCorrupted,
  MessageHandle,
  MessageId,
  MessageNotAvailable,
  MessageNotFound,
  ReceivedMessage,
  TopicName,
} from "./queue-domain.ts";

/** Maximum number of messages one receive call may lease: an integer from 1 to 10. */
export const ReceiveLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })).pipe(
  Schema.brand("ReceiveLimit"),
);

/** Maximum number of messages one receive call may lease: an integer from 1 to 10. */
export type ReceiveLimit = typeof ReceiveLimit.Type;

/** Options for publishing one message, shared by single and batch sends. */
export interface PublishOptions {
  /** Drops a later publish carrying the same key while the first is retained. */
  readonly idempotencyKey?: IdempotencyKey;

  /** How long the message is kept: 1 minute to 7 days, default 24 hours. */
  readonly retention?: Duration.Input;

  /** Delay before the message becomes visible: up to 7 days and never beyond its retention. */
  readonly delay?: Duration.Input;

  /** Custom headers stored with the message. */
  readonly headers?: Readonly<Record<string, string>>;

  /** **Experimental.** See {@link ConcurrencyKey}. */
  readonly experimentalConcurrencyKey?: ConcurrencyKey;
}

/** A serialized message ready to publish. */
export interface OutgoingMessage extends PublishOptions {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/** Outcome of publishing one message. */
export type SendResult = Data.TaggedEnum<{
  /** The queue accepted the message and assigned it an identifier. */
  Sent: { readonly messageId: MessageId };
  /** The queue accepted the message for deferred processing; it has no identifier yet. */
  Deferred: {};
}>;

/** Constructors and matchers for {@link SendResult}. */
export const SendResult = Data.taggedEnum<SendResult>();

/**
 * Outcome for one entry of a batch send, in input order.
 *
 * A request-level failure returns no per-entry results and may happen after the queue accepted
 * some entries; set an idempotency key on every entry from the first attempt to make retries safe.
 */
export type BatchSendResult = Data.TaggedEnum<{
  Sent: { readonly messageId: MessageId };
  Deferred: {};
  /** The queue rejected this entry; the others may still have been accepted. */
  Failed: {
    readonly status: number;
    readonly message: string;
    /** Whether publishing this entry again may succeed. */
    readonly retryable: boolean;
  };
}>;

/** Constructors and matchers for {@link BatchSendResult}. */
export const BatchSendResult = Data.taggedEnum<BatchSendResult>();

/** Result of extending a lease with an experimental handoff request. */
export const HandoffOutcome = Schema.Literals(["accepted", "not_immediate", "limit_reached"]);

/** Result of extending a lease with an experimental handoff request. */
export type HandoffOutcome = typeof HandoffOutcome.Type;

/** Options for leasing messages from a consumer group. */
export interface ReceiveOptions {
  /** Maximum messages to lease; the queue's default is 1. */
  readonly limit?: ReceiveLimit;

  /** How long leased messages stay invisible to other consumers. */
  readonly visibilityTimeout?: Duration.Input;

  /** Where a consumer group with no stored position starts reading. */
  readonly cursorFallback?: CursorFallback;

  /** Region to receive from; defaults to `QueueConfig.region`. */
  readonly region?: VercelRegion;
}

/** Options for leasing one message by identifier. */
export interface ReceiveByIdOptions {
  readonly visibilityTimeout?: Duration.Input;

  /** Region that holds the message; defaults to `QueueConfig.region`. */
  readonly region?: VercelRegion;
}

/** Failures every queue call can report. */
export type QueueRequestError = VercelApiError | ConsumerRegistryNotConfigured;

/** Failures of publishing. */
export type QueueSendError = QueueRequestError | ConsumerDiscoveryFailed;

/** Failures of publishing a batch. */
export type QueueSendBatchError = QueueSendError | BatchSizeOutOfRange;

/** Failures of leasing a specific message. */
export type QueueReceiveByIdError =
  | QueueRequestError
  | MessageNotFound
  | MessageNotAvailable
  | MessageAlreadyProcessed
  | MessageCorrupted;

/** Failures of settling a lease: acknowledging it or changing its visibility. */
export type QueueLeaseError = QueueRequestError | MessageNotFound | MessageNotAvailable;

/**
 * The Vercel Queues HTTP API, one operation per endpoint, with bodies as bytes.
 *
 * Most code uses `QueueProducer`, `QueueConsumer` or `QueuePoller`, which add typed topics, leases
 * and tracing on top of this service.
 */
export class QueueApi extends Context.Service<
  QueueApi,
  {
    /** Publish one message (`POST /api/v3/topic/{topic}`). */
    readonly send: (
      topic: TopicName,
      message: OutgoingMessage,
    ) => Effect.Effect<SendResult, QueueSendError>;

    /** Publish 1 to 100 messages in one request (`POST /api/v3/topic/{topic}/batch`). */
    readonly sendBatch: (
      topic: TopicName,
      messages: Array.NonEmptyReadonlyArray<OutgoingMessage>,
    ) => Effect.Effect<ReadonlyArray<BatchSendResult>, QueueSendBatchError>;

    /**
     * Lease the next available messages of a consumer group. An empty array means the queue had
     * nothing to deliver.
     */
    readonly receive: (
      topic: TopicName,
      consumerGroup: ConsumerGroupName,
      options?: ReceiveOptions,
    ) => Effect.Effect<ReadonlyArray<ReceivedMessage>, QueueRequestError | MessageCorrupted>;

    /** Lease one message by identifier, as push delivery does for messages sent without a body. */
    readonly receiveById: (
      topic: TopicName,
      consumerGroup: ConsumerGroupName,
      messageId: MessageId,
      options?: ReceiveByIdOptions,
    ) => Effect.Effect<ReceivedMessage, QueueReceiveByIdError>;

    /**
     * Acknowledge a leased message so the consumer group never receives it again.
     *
     * `experimentalIfCoalesced` acknowledges only if no more than that many messages have been
     * coalesced into the delivery; otherwise it fails with `ConcurrencyCoalescedPending`.
     */
    readonly acknowledge: (
      handle: MessageHandle,
      options?: { readonly experimentalIfCoalesced?: number },
    ) => Effect.Effect<void, QueueLeaseError>;

    /**
     * Set how long a leased message stays invisible, counted from now. A zero timeout releases the
     * lease for immediate redelivery.
     *
     * @returns The handoff outcome when `experimentalHandoff` was requested, otherwise none.
     */
    readonly changeVisibility: (
      handle: MessageHandle,
      visibilityTimeout: Duration.Input,
      options?: { readonly experimentalHandoff?: boolean },
    ) => Effect.Effect<Option.Option<HandoffOutcome>, QueueLeaseError>;
  }
>()("@effect-vercel/queue/QueueApi") {}
