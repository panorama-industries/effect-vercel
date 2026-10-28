import type { Config } from "effect";
import type { HttpClient } from "effect/http";

import { VercelOidcLive, VercelSystemEnvLive } from "@panorama-industries/effect-vercel-core";
import { Layer } from "effect";

import type { QueueConsumer } from "../contracts/queue-consumer.ts";
import type { QueuePoller } from "../contracts/queue-poller.ts";
import type { QueueProducer } from "../contracts/queue-producer.ts";

import { QueueApiLive } from "./queue-api-live.ts";
import { QueueConfigLive } from "./queue-config-live.ts";
import { QueueConsumerLive } from "./queue-consumer-live.ts";
import { QueuePollerLive } from "./queue-poller-live.ts";
import { QueueProducerLive } from "./queue-producer-live.ts";

/**
 * Producer, push consumer and poller configured from the Vercel environment, authenticated with
 * the function's OIDC token. Provide an `HttpClient`, e.g. `FetchHttpClient.layer`.
 *
 * Compose the individual layers instead to override configuration (`queueConfigLayer`) or
 * credentials.
 */
export const QueueLive: Layer.Layer<
  QueueProducer | QueueConsumer | QueuePoller,
  Config.ConfigError,
  HttpClient.HttpClient
> = Layer.mergeAll(QueueProducerLive, QueueConsumerLive, QueuePollerLive).pipe(
  Layer.provideMerge(QueueApiLive),
  Layer.provide(Layer.mergeAll(QueueConfigLive, VercelOidcLive)),
  Layer.provide(VercelSystemEnvLive),
);
