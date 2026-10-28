import type { Array, Effect } from "effect";

import { Context } from "effect";

import type { BatchSendResult, PublishOptions, QueueSendError, SendResult } from "./queue-api.ts";
import type { PayloadEncodeFailed } from "./queue-domain.ts";
import type { Topic } from "./topic.ts";

/** One payload of a batch send with its publish options. */
export interface BatchEntry<A> extends PublishOptions {
  readonly payload: A;
}

/** Publishes typed payloads to topics. */
export class QueueProducer extends Context.Service<
  QueueProducer,
  {
    /** Encode a payload with its topic's schema and publish it, in a `vqs.send` producer span. */
    readonly send: <A, I>(
      topic: Topic<A, I>,
      payload: A,
      options?: PublishOptions,
    ) => Effect.Effect<SendResult, QueueSendError | PayloadEncodeFailed>;

    /**
     * Encode and publish 1 to 100 payloads in one request. Inspect every result: a batch can mix
     * sent, deferred and failed entries.
     */
    readonly sendBatch: <A, I>(
      topic: Topic<A, I>,
      entries: Array.NonEmptyReadonlyArray<BatchEntry<A>>,
    ) => Effect.Effect<ReadonlyArray<BatchSendResult>, QueueSendError | PayloadEncodeFailed>;
  }
>()("@effect-vercel/queue/QueueProducer") {}
