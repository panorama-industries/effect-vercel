import type { Duration, Effect } from "effect";

import { Data } from "effect";

import type {
  ConcurrencyCoalescedPending,
  MessageMetadata,
  PayloadDecodeFailed,
} from "./queue-domain.ts";

/** What to do with a message whose handler failed. */
export type RetryDirective = Data.TaggedEnum<{
  /** Acknowledge the message so it is never delivered again. */
  Acknowledge: {};
  /** Release the lease and redeliver the message after `delay`. */
  RetryAfter: { readonly delay: Duration.Duration };
  /**
   * **Experimental.** End the lease now and redeliver immediately. A handoff counts toward neither
   * the queue's retry backoff nor its maximum attempts; past the queue's bound it is an ordinary
   * retry.
   */
  ExperimentalHandoff: {};
  /**
   * Leave the message to the queue's own redelivery. Push consumers answer HTTP 500; pollers return
   * the handler's error and let the lease expire.
   */
  Fail: {};
}>;

/** Constructors and matchers for {@link RetryDirective}. */
export const RetryDirective = Data.taggedEnum<RetryDirective>();

/**
 * Processes one delivered payload. Succeeding acknowledges the message; failing hands the error to
 * {@link ConsumeOptions.onError}.
 */
export type MessageHandler<A, E, R> = (
  payload: A,
  metadata: MessageMetadata,
) => Effect.Effect<void, E, R>;

/** Failures a consumer's error policy can receive besides the handler's own errors. */
export type ConsumeFailure = PayloadDecodeFailed | ConcurrencyCoalescedPending;

/** How a consumer holds leases and reacts to failures. */
export interface ConsumeOptions<E, R = never> {
  /**
   * How long a lease lasts before it must be renewed. The consumer renews it in the background
   * while the handler runs. Default: 5 minutes.
   */
  readonly visibilityTimeout?: Duration.Input;

  /**
   * Choose a {@link RetryDirective} for a failed handler, an undecodable payload, or an
   * acknowledgment refused after the coalesced reruns are used up. Default: `Fail`. Defects always
   * mean `Fail`.
   */
  readonly onError?: (
    error: E | ConsumeFailure,
    metadata: MessageMetadata,
  ) => Effect.Effect<RetryDirective, never, R>;

  /**
   * **Experimental.** Rerun the handler, with the lease still held, up to this many times when its
   * acknowledgment is refused because messages were coalesced into the delivery. Default: 0.
   */
  readonly experimentalMaxCoalescedReruns?: number;
}
