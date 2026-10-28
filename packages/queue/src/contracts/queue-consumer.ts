import type { Effect } from "effect";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";

import { Context } from "effect";

import type { ConsumeOptions, MessageHandler } from "./message-handling.ts";
import type { Topic } from "./topic.ts";

/**
 * Handles push deliveries: Vercel Queues calls a function route with a CloudEvent, and the route
 * leases, processes and settles the message.
 *
 * ```ts
 * export const POST = HttpEffect.toWebHandlerLayer(
 *   QueueConsumer.use((consumer) => consumer.handler(Orders, fulfil)),
 *   AppLayer,
 * ).handler;
 * ```
 */
export class QueueConsumer extends Context.Service<
  QueueConsumer,
  {
    /**
     * Build the HTTP handler for a push-delivered topic.
     *
     * Accepts structured (`com.vercel.queue.v1beta`) and binary (`com.vercel.queue.v2beta`)
     * CloudEvents. Responds 200 when the message was processed or was already settled elsewhere,
     * 400 for a malformed CloudEvent, and 500 to request redelivery.
     */
    readonly handler: <A, I, E, R, R2 = never>(
      topic: Topic<A, I>,
      handle: MessageHandler<A, E, R>,
      options?: ConsumeOptions<E, R2>,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | R | R2
    >;
  }
>()("@effect-vercel/queue/QueueConsumer") {}
