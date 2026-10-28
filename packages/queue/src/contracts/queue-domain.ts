import { VercelRegion } from "@panorama-industries/effect-vercel-core";
import { Schema } from "effect";

/** Name of a queue topic: letters, digits, `_` and `-`. */
export const TopicName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)).pipe(
  Schema.brand("TopicName"),
);

/** Name of a queue topic: letters, digits, `_` and `-`. */
export type TopicName = typeof TopicName.Type;

/** Name of a consumer group; each group receives every message of a topic once. */
export const ConsumerGroupName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)).pipe(
  Schema.brand("ConsumerGroupName"),
);

/** Name of a consumer group; each group receives every message of a topic once. */
export type ConsumerGroupName = typeof ConsumerGroupName.Type;

/** Identifier the queue assigns to a message when it accepts it. */
export const MessageId = Schema.NonEmptyString.pipe(Schema.brand("MessageId"));

/** Identifier the queue assigns to a message when it accepts it. */
export type MessageId = typeof MessageId.Type;

/** Proof of one lease on a message; acknowledging or extending the lease requires it. */
export const ReceiptHandle = Schema.NonEmptyString.pipe(Schema.brand("ReceiptHandle"));

/** Proof of one lease on a message. */
export type ReceiptHandle = typeof ReceiptHandle.Type;

/** Key the queue uses to drop duplicate publishes of the same logical message. */
export const IdempotencyKey = Schema.NonEmptyString.pipe(Schema.brand("IdempotencyKey"));

/** Key the queue uses to drop duplicate publishes of the same logical message. */
export type IdempotencyKey = typeof IdempotencyKey.Type;

/**
 * **Experimental.** Key that serializes processing: at most one message per key is leased at a
 * time, and messages published while one is in flight may be coalesced into it.
 */
export const ConcurrencyKey = Schema.NonEmptyString.pipe(Schema.brand("ConcurrencyKey"));

/** **Experimental.** Key that serializes processing of messages that share it. */
export type ConcurrencyKey = typeof ConcurrencyKey.Type;

/** Where a consumer group with no stored position starts reading a topic. */
export const CursorFallback = Schema.Literals(["earliest", "latest"]);

/** Where a consumer group with no stored position starts reading a topic. */
export type CursorFallback = typeof CursorFallback.Type;

/** Everything needed to acknowledge a leased message or change its visibility. */
export class MessageHandle extends Schema.Class<MessageHandle>(
  "@effect-vercel/queue/MessageHandle",
)({
  topic: TopicName,
  consumerGroup: ConsumerGroupName,
  messageId: MessageId,
  receiptHandle: ReceiptHandle,
  /** Region that issued the lease; follow-up calls must go to the same region. */
  region: VercelRegion,
}) {}

/** **Experimental.** Present when a handler run is a rerun caused by coalesced messages. */
export const ExperimentalCoalesced = Schema.Struct({
  /** Which rerun of this delivery is executing, from 1. */
  rerun: Schema.Int,
  /** How many messages had been coalesced into this delivery when its acknowledgment was refused. */
  coalescedCount: Schema.Int,
});

/** Facts about one delivery of a message, passed to message handlers. */
export class MessageMetadata extends Schema.Class<MessageMetadata>(
  "@effect-vercel/queue/MessageMetadata",
)({
  messageId: MessageId,
  /** Number of times the message has been delivered, including this delivery (from 1). */
  deliveryCount: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  /** When the message expires and stops being delivered, set by its retention. */
  expiresAt: Schema.DateTimeUtc,
  topic: TopicName,
  consumerGroup: ConsumerGroupName,
  region: VercelRegion,
  /** **Experimental.** How many handoffs preceded this delivery. */
  experimentalHandoffCount: Schema.optionalKey(Schema.Int),
  experimentalCoalesced: Schema.optionalKey(ExperimentalCoalesced),
}) {}

/** A leased message as returned by the queue, before its payload is decoded. */
export class ReceivedMessage extends Schema.Class<ReceivedMessage>(
  "@effect-vercel/queue/ReceivedMessage",
)({
  handle: MessageHandle,
  metadata: MessageMetadata,
  contentType: Schema.String,
  body: Schema.Uint8Array,
}) {}

/** The message does not exist, or has expired (HTTP 404). */
export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()("MessageNotFound", {
  messageId: Schema.String,
}) {}

/** Another consumer holds the lease; retry once it is released. */
export class MessageLocked extends Schema.TaggedError<MessageLocked>()("MessageLocked", {
  /** Delay the queue suggested before retrying, when it sent one. */
  retryAfter: Schema.Option(Schema.Duration),
}) {}

/**
 * **Experimental.** The acknowledgment was refused because messages with the same concurrency key
 * were coalesced into this delivery after it started.
 */
export class ConcurrencyCoalescedPending extends Schema.TaggedError<ConcurrencyCoalescedPending>()(
  "ConcurrencyCoalescedPending",
  {
    coalescedCount: Schema.Int,
  },
) {}

/** The message exists but cannot be leased or settled right now, for no more specific reason. */
export class MessageUnavailable extends Schema.TaggedError<MessageUnavailable>()(
  "MessageUnavailable",
  {
    message: Schema.String,
  },
) {}

/** The message cannot be leased or settled by this consumer (HTTP 409). */
export class MessageNotAvailable extends Schema.TaggedError<MessageNotAvailable>()(
  "MessageNotAvailable",
  {
    messageId: Schema.String,
    reason: Schema.Union([MessageLocked, ConcurrencyCoalescedPending, MessageUnavailable]),
  },
) {}

/** The message was already acknowledged by this consumer group (HTTP 410). */
export class MessageAlreadyProcessed extends Schema.TaggedError<MessageAlreadyProcessed>()(
  "MessageAlreadyProcessed",
  {
    messageId: Schema.String,
  },
) {}

/** The queue returned a message whose headers or body could not be read. */
export class MessageCorrupted extends Schema.TaggedError<MessageCorrupted>()("MessageCorrupted", {
  messageId: Schema.String,
  message: Schema.String,
}) {}

/**
 * The queue could not reach the deployment that consumes this topic (HTTP 502,
 * `consumer_discovery_failed`), usually because the pinned deployment is gone.
 */
export class ConsumerDiscoveryFailed extends Schema.TaggedError<ConsumerDiscoveryFailed>()(
  "ConsumerDiscoveryFailed",
  {
    message: Schema.String,
  },
) {}

/**
 * The project has no consumer registry, so messages cannot be routed to consumers (HTTP 503,
 * `consumer_registry_not_configured`).
 */
export class ConsumerRegistryNotConfigured extends Schema.TaggedError<ConsumerRegistryNotConfigured>()(
  "ConsumerRegistryNotConfigured",
  {
    message: Schema.String,
  },
) {}

/** A batch send had no entries or more than the queue's limit of 100. */
export class BatchSizeOutOfRange extends Schema.TaggedError<BatchSizeOutOfRange>()(
  "BatchSizeOutOfRange",
  {
    size: Schema.Int,
    maximum: Schema.Int,
  },
) {}

/** A payload did not match its topic's schema when it was published. */
export class PayloadEncodeFailed extends Schema.TaggedError<PayloadEncodeFailed>()(
  "PayloadEncodeFailed",
  {
    topic: Schema.String,
    message: Schema.String,
  },
) {}

/** A delivered message body did not match its topic's schema. */
export class PayloadDecodeFailed extends Schema.TaggedError<PayloadDecodeFailed>()(
  "PayloadDecodeFailed",
  {
    topic: Schema.String,
    messageId: Schema.String,
    message: Schema.String,
  },
) {}
