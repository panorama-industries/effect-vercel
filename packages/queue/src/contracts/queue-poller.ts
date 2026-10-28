import type { Effect } from "effect";

import { Context, Data } from "effect";

import type { ConsumeOptions, MessageHandler } from "./message-handling.ts";
import type { QueueRequestError, ReceiveByIdOptions, ReceiveOptions } from "./queue-api.ts";
import type { ConsumerGroupName, MessageCorrupted, MessageId } from "./queue-domain.ts";
import type { Topic } from "./topic.ts";

/** What a poll did. */
export type ReceiveOutcome = Data.TaggedEnum<{
  /** This many messages were leased and handled. */
  Processed: { readonly count: number };
  /** The consumer group had nothing to deliver. */
  Empty: {};
  /** The requested message does not exist or has expired. */
  NotFound: { readonly messageId: MessageId };
  /** Another consumer holds the requested message. */
  NotAvailable: { readonly messageId: MessageId };
  /** The requested message was already acknowledged by this consumer group. */
  AlreadyProcessed: { readonly messageId: MessageId };
}>;

/** Constructors and matchers for {@link ReceiveOutcome}. */
export const ReceiveOutcome = Data.taggedEnum<ReceiveOutcome>();

/** Options for one poll: lease options plus how to handle the leased messages. */
export type PollOptions<E, R> = ConsumeOptions<E, R> &
  Pick<ReceiveOptions, "limit" | "cursorFallback" | "region">;

/** Options for polling one message by identifier. */
export type PollByIdOptions<E, R> = ConsumeOptions<E, R> & Pick<ReceiveByIdOptions, "region">;

/**
 * Pulls messages from a consumer group and handles them, for workloads that run outside push
 * delivery such as workers and cron jobs.
 */
export class QueuePoller extends Context.Service<
  QueuePoller,
  {
    /**
     * Lease up to `limit` messages and handle them concurrently.
     *
     * @returns The outcome, or the handler's error when the error policy answered `Fail`.
     */
    readonly receive: <A, I, E, R, R2 = never>(
      topic: Topic<A, I>,
      consumerGroup: ConsumerGroupName,
      handle: MessageHandler<A, E, R>,
      options?: PollOptions<E, R2>,
    ) => Effect.Effect<ReceiveOutcome, E | QueueRequestError | MessageCorrupted, R | R2>;

    /** Lease one message by identifier and handle it. */
    readonly receiveById: <A, I, E, R, R2 = never>(
      topic: Topic<A, I>,
      consumerGroup: ConsumerGroupName,
      messageId: MessageId,
      handle: MessageHandler<A, E, R>,
      options?: PollByIdOptions<E, R2>,
    ) => Effect.Effect<ReceiveOutcome, E | QueueRequestError | MessageCorrupted, R | R2>;
  }
>()("@effect-vercel/queue/QueuePoller") {}
