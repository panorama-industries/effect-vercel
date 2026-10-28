import type {
  TestHttpRequest,
  TestHttpResponse,
} from "@panorama-industries/effect-vercel-core/testing";
import type { HttpClient } from "effect/http";

import {
  DeploymentId,
  VercelRegion,
  vercelOidcFromToken,
} from "@panorama-industries/effect-vercel-core";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import { BufferTransport, PollingQueueClient } from "@vercel/queue";
import { Duration, Effect, Layer, Match, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import type {
  QueueLeaseError,
  QueueReceiveByIdError,
  QueueRequestError,
  QueueSendBatchError,
  QueueSendError,
} from "../../src/contracts/queue-api.ts";
import type { MessageCorrupted } from "../../src/contracts/queue-domain.ts";

import { QueueApi } from "../../src/contracts/queue-api.ts";
import { QueueAuth, QueueConfig } from "../../src/contracts/queue-config.ts";
import { QueueApiLive } from "../../src/implementation/queue-api-live.ts";

/** The pieces of the SDK's internal `ApiClient` the suite drives directly. */
export interface SdkApiClient {
  withRegion(region: string): SdkApiClient;
  sendMessage(options: Record<string, unknown>): Promise<{ messageId: string | null }>;
  sendBatch(options: Record<string, unknown>): Promise<ReadonlyArray<Record<string, unknown>>>;
  receiveMessages(options: Record<string, unknown>): AsyncGenerator<SdkMessage>;
  receiveMessageById(options: Record<string, unknown>): Promise<{ message: SdkMessage }>;
  acknowledgeMessage(options: Record<string, unknown>): Promise<unknown>;
  changeVisibility(options: Record<string, unknown>): Promise<{ experimental_handoff?: string }>;
}

export interface SdkMessage {
  readonly messageId: string;
  readonly payload: Uint8Array;
  readonly deliveryCount: number;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
  readonly contentType: string;
  readonly receiptHandle: string;
  readonly experimental_handoffCount?: number;
}

export interface Setup {
  readonly pinned: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

export const defaultSetup: Setup = { pinned: true, headers: { "x-custom": "custom" } };

const baseUrl = (server: string) => (region: string) => new URL(`${server}/${region}/`);

export const sdkApi = (server: string, setup: Setup = defaultSetup): SdkApiClient => {
  const client = new PollingQueueClient({
    region: "iad1",
    resolveBaseUrl: baseUrl(server),
    token: "secret",
    deploymentId: setup.pinned ? "dpl_1" : null,
    headers: { ...setup.headers },
    transport: new BufferTransport(),
  });
  return (client as unknown as Record<symbol, SdkApiClient>)[
    Symbol.for("@vercel/queue.apiClient")
  ] as SdkApiClient;
};

export const ourLayer = (
  setup: Setup = defaultSetup,
): Layer.Layer<QueueApi | TestHttpServer, never, never> => {
  const config = Layer.effect(
    QueueConfig,
    Effect.map(Effect.service(TestHttpServer), (server) =>
      QueueConfig.of({
        region: VercelRegion.make("iad1"),
        baseUrl: (region) => baseUrl(server.url)(region),
        auth: QueueAuth.Token({ token: Redacted.make("secret") }),
        deploymentId: setup.pinned ? Option.some(DeploymentId.make("dpl_1")) : Option.none(),
        pinSends: setup.pinned,
        headers: setup.headers,
      }),
    ),
  );
  const http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer;
  return QueueApiLive.pipe(
    Layer.provide(config),
    Layer.provideMerge(TestHttpServerLive()),
    Layer.provide(vercelOidcFromToken(Redacted.make("unused"))),
    Layer.provide(http),
  );
};

const volatileHeaders = new Set([
  "user-agent",
  "vqs-client-ts",
  "traceparent",
  "tracestate",
  "baggage",
  "b3",
  "content-length",
  "transfer-encoding",
  "connection",
  "host",
]);

export interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const normalizeRequest = (request: TestHttpRequest): WireRequest => {
  const boundary = /boundary=([^;]+)/.exec(request.headers["content-type"] ?? "")?.[1];
  const scrub = (value: string) =>
    boundary === undefined ? value : value.replaceAll(boundary, "<boundary>");
  const headers: Record<string, string> = {};
  for (const name of Object.keys(request.headers).toSorted()) {
    if (!volatileHeaders.has(name)) headers[name] = scrub(request.headers[name] ?? "");
  }
  return { method: request.method, url: request.url, headers, body: scrub(request.text) };
};

export type Outcome<A> = { readonly ok: A } | { readonly error: string };

const seconds = (duration: Option.Option<Duration.Duration>) =>
  Option.match(duration, { onNone: () => "none", onSome: (d) => String(Duration.toSeconds(d)) });

export const sdkErrorLabel = (error: unknown): string => {
  if (!(error instanceof Error)) return `NonError(${String(error)})`;
  const fields = error as Error & { retryAfter?: number; coalescedCount?: number };
  return Match.value(error.name).pipe(
    Match.when("BadRequestError", () => "BadRequest"),
    Match.when("UnauthorizedError", () => "Unauthorized"),
    Match.when("ForbiddenError", () => "Forbidden"),
    Match.when("PayloadTooLargeError", () => "PayloadTooLarge"),
    Match.when("TooManyRequestsError", () => `RateLimited(${fields.retryAfter ?? "none"})`),
    Match.when("InternalServerError", () => "ServerError"),
    Match.when("MessageNotFoundError", () => "NotFound"),
    Match.when("MessageLockedError", () => `Locked(${fields.retryAfter ?? "none"})`),
    Match.when(
      "ConcurrencyCoalescedPendingError",
      () => `CoalescedPending(${fields.coalescedCount})`,
    ),
    Match.when(
      "MessageNotAvailableError",
      () =>
        `NotAvailable(${error.message.replace(/^Message \S+ not available for processing: /, "")})`,
    ),
    Match.when("MessageAlreadyProcessedError", () => "AlreadyProcessed"),
    Match.when("MessageCorruptedError", () => "Corrupted"),
    Match.when("ConsumerDiscoveryError", () => `DiscoveryFailed(${error.message})`),
    Match.when(
      "ConsumerRegistryNotConfiguredError",
      () => `RegistryNotConfigured(${error.message})`,
    ),
    Match.orElse(() => "Unexpected"),
  );
};

type OurError =
  | QueueSendError
  | QueueSendBatchError
  | QueueReceiveByIdError
  | QueueLeaseError
  | QueueRequestError
  | MessageCorrupted;

export const ourErrorLabel = (error: OurError): string =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      VercelApiError: (apiError) =>
        Match.value(apiError.reason).pipe(
          Match.tagsExhaustive({
            ApiBadRequest: () => "BadRequest",
            ApiUnauthorized: () => "Unauthorized",
            ApiForbidden: () => "Forbidden",
            ApiPayloadTooLarge: () => "PayloadTooLarge",
            ApiRateLimited: (reason) => `RateLimited(${seconds(reason.retryAfter)})`,
            ApiServerError: () => "ServerError",
            ApiNetworkFailure: () => "Network",
            ApiUnexpectedResponse: () => "Unexpected",
          }),
        ),
      BatchSizeOutOfRange: () => "BatchSize",
      MessageNotFound: () => "NotFound",
      MessageNotAvailable: (notAvailable) =>
        Match.value(notAvailable.reason).pipe(
          Match.tagsExhaustive({
            MessageLocked: (reason) => `Locked(${seconds(reason.retryAfter)})`,
            ConcurrencyCoalescedPending: (reason) => `CoalescedPending(${reason.coalescedCount})`,
            MessageUnavailable: (reason) => `NotAvailable(${reason.message})`,
          }),
        ),
      MessageAlreadyProcessed: () => "AlreadyProcessed",
      MessageCorrupted: () => "Corrupted",
      ConsumerDiscoveryFailed: (failed) => `DiscoveryFailed(${failed.message})`,
      ConsumerRegistryNotConfigured: (failed) => `RegistryNotConfigured(${failed.message})`,
    }),
  );

export const sdkOutcome = <A, B>(
  call: () => Promise<A>,
  normalize: (value: A) => B,
): Effect.Effect<Outcome<B>> =>
  Effect.promise(() =>
    call().then(
      (value) => ({ ok: normalize(value) }),
      (error: unknown) => ({ error: sdkErrorLabel(error) }),
    ),
  );

export const ourOutcome = <A, B, E extends OurError, R>(
  effect: Effect.Effect<A, E, R>,
  normalize: (value: A) => B,
): Effect.Effect<Outcome<B>, never, R> =>
  effect.pipe(
    Effect.map((value): Outcome<B> => ({ ok: normalize(value) })),
    Effect.catch((error: E) => Effect.succeed<Outcome<B>>({ error: ourErrorLabel(error) })),
  );

export interface Comparison<B> {
  readonly sdk: Outcome<B>;
  readonly ours: Outcome<B>;
  readonly sdkRequest: WireRequest | undefined;
  readonly ourRequest: WireRequest | undefined;
}

/**
 * Answer every request with `response`, run the SDK call and then ours, and return both outcomes
 * with the first request each one sent.
 */
export const compare = Effect.fnUntraced(function* <B>(
  response: TestHttpResponse | ((request: TestHttpRequest) => TestHttpResponse),
  sdk: (server: string) => Effect.Effect<Outcome<B>>,
  ours: Effect.Effect<Outcome<B>, never, QueueApi>,
): Effect.fn.Return<Comparison<B>, never, QueueApi | TestHttpServer> {
  const server = yield* TestHttpServer;
  yield* server.setHandler(typeof response === "function" ? response : () => response);
  const before = (yield* server.requests).length;
  const sdkResult = yield* sdk(server.url);
  const middle = (yield* server.requests).length;
  const ourResult = yield* ours;
  const requests = yield* server.requests;
  const first = (index: number, end: number) =>
    index < end && requests[index] !== undefined ? normalizeRequest(requests[index]) : undefined;
  return {
    sdk: sdkResult,
    ours: ourResult,
    sdkRequest: first(before, middle),
    ourRequest: first(middle, requests.length),
  };
});
