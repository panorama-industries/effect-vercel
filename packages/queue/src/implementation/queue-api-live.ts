import type { VercelRegion } from "@panorama-industries/effect-vercel-core";
import type { HttpClientError, HttpClientResponse } from "effect/http";

import {
  ApiRateLimited,
  ApiUnauthorized,
  ApiUnexpectedResponse,
  VercelApiError,
  VercelOidc,
  vercelApiErrorFromHttpClientError,
  vercelApiErrorFromResponse,
  withVercelApi,
} from "@panorama-industries/effect-vercel-core";
import {
  Array as Arr,
  Clock,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Random,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type {
  OutgoingMessage,
  QueueLeaseError,
  QueueReceiveByIdError,
  QueueRequestError,
  QueueSendBatchError,
  QueueSendError,
  ReceiveByIdOptions,
  ReceiveOptions,
} from "../contracts/queue-api.ts";
import type { ConsumerGroupName, TopicName } from "../contracts/queue-domain.ts";
import type { MultipartPart } from "../internal/multipart.ts";
import type { QueuePartHeaders } from "../internal/queue-protocol.ts";

import { BatchSendResult, HandoffOutcome, QueueApi, SendResult } from "../contracts/queue-api.ts";
import { QueueAuth, QueueConfig } from "../contracts/queue-config.ts";
import {
  BatchSizeOutOfRange,
  ConcurrencyCoalescedPending,
  ConsumerDiscoveryFailed,
  ConsumerRegistryNotConfigured,
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
} from "../contracts/queue-domain.ts";
import {
  boundaryFromContentType,
  decodeMultipartMixed,
  encodeMultipartMixed,
} from "../internal/multipart.ts";
import {
  HeaderSet,
  apiBaseUrl,
  coalescedPendingCount,
  errorBodyOf,
  errorCodeHeader,
  messageHeaders,
  parseDate,
  queuePartHeaders,
  retryAfterFromHeader,
  topicPath,
  wholeSeconds,
} from "../internal/queue-protocol.ts";
import { userAgent } from "../internal/version.ts";

type Response = HttpClientResponse.HttpClientResponse;

const defaultRetention = Duration.hours(24);

const leaseCallAttempts = 3;

const SendResponse = Schema.fromJsonString(
  Schema.Struct({ messageId: Schema.NullOr(Schema.String) }),
);

const BatchResponse = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Union([
        Schema.Struct({ status: Schema.Literal("sent"), messageId: MessageId }),
        Schema.Struct({ status: Schema.Literal("deferred") }),
        Schema.Struct({
          status: Schema.Literal("failed"),
          statusCode: Schema.Int,
          error: Schema.String,
          retryable: Schema.Boolean,
        }),
      ]),
    ),
  }),
);

const decodeHandoffOutcome = Schema.decodeUnknownOption(HandoffOutcome);

const header = (response: Response, name: string): string | undefined =>
  response.headers[name.toLowerCase()];

const unexpected = (operation: string, status: number, message: string) =>
  new VercelApiError({
    operation,
    errorCode: Option.none(),
    reason: new ApiUnexpectedResponse({ message, status }),
  });

const isRetryableLeaseError = (error: unknown): boolean =>
  error instanceof VercelApiError &&
  (Predicate.isTagged(error.reason, "ApiNetworkFailure") ||
    (Predicate.isTagged(error.reason, "ApiRateLimited") && Option.isSome(error.reason.retryAfter)));

const leaseRetry = Schedule.forever.pipe(
  Schedule.setInputType<unknown>(),
  Schedule.while(
    ({ input, attempt }) => attempt < leaseCallAttempts && isRetryableLeaseError(input),
  ),
  Schedule.modifyDelay(({ input, attempt }) => {
    if (
      input instanceof VercelApiError &&
      Predicate.isTagged(input.reason, "ApiRateLimited") &&
      Option.isSome(input.reason.retryAfter)
    ) {
      return Effect.succeed(input.reason.retryAfter.value);
    }
    const base = 250 * attempt;
    return Effect.map(Random.nextBetween(base / 2, base), Duration.millis);
  }),
);

const maxBatchSize = 100;

/**
 * Implements {@link QueueApi} over HTTP with the same requests, headers and status handling as
 * `@vercel/queue`.
 *
 * Requires `HttpClient`, `QueueConfig` and `VercelOidc` (used only with `QueueAuth.Oidc`). A
 * missing OIDC token fails calls with `VercelApiError` (`ApiUnauthorized`). Acknowledging and
 * changing visibility make up to 3 attempts when the request never reached the queue or was
 * rate limited with a `Retry-After` delay; nothing else is retried.
 */
export const QueueApiLive: Layer.Layer<
  QueueApi,
  never,
  HttpClient.HttpClient | QueueConfig | VercelOidc
> = Layer.effect(
  QueueApi,
  Effect.gen(function* () {
    const config = yield* QueueConfig;
    const oidc = yield* VercelOidc;
    const httpClient = yield* HttpClient.HttpClient;

    const token = QueueAuth.$match(config.auth, {
      Token: ({ token }) => Effect.succeed(token),
      Oidc: () => oidc.token,
    });

    const deploymentHeader = (pinned: boolean) =>
      HttpClientRequest.setHeaders(
        pinned
          ? Option.match(config.deploymentId, {
              onNone: () => ({}),
              onSome: (id) => ({ "vqs-deployment-id": id }),
            })
          : {},
      );

    const execute = (
      operation: string,
      region: VercelRegion,
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<Response, VercelApiError> =>
      httpClient.pipe(
        withVercelApi({ baseUrl: apiBaseUrl(config.baseUrl(region)), token, userAgent }),
        HttpClient.mapRequestEffect((request) =>
          Effect.map(DateTime.now, (now) =>
            HttpClientRequest.setHeader(request, "vqs-client-ts", DateTime.formatIso(now)),
          ),
        ),
        (client) => client.execute(request),
        Effect.catchTags({
          HttpClientError: (error: HttpClientError.HttpClientError) =>
            vercelApiErrorFromHttpClientError(error, { operation, errorCodeHeader }),
          OidcTokenUnavailable: (error) =>
            Effect.fail(
              new VercelApiError({
                operation,
                errorCode: Option.none(),
                reason: new ApiUnauthorized({ message: error.message }),
              }),
            ),
        }),
      );

    const readErrorBody = (response: Response) =>
      Effect.map(
        Effect.orElseSucceed(response.text, () => ""),
        (text) => errorBodyOf(text, header(response, "content-type")),
      );

    const failCommon = Effect.fnUntraced(function* (
      operation: string,
      response: Response,
    ): Effect.fn.Return<never, QueueRequestError> {
      const body = yield* readErrorBody(response);
      if (
        response.status === 503 &&
        header(response, errorCodeHeader) === "consumer_registry_not_configured"
      ) {
        return yield* new ConsumerRegistryNotConfigured({
          message: body.message || "Consumer registry not configured",
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const error = yield* Effect.flip(
        vercelApiErrorFromResponse(response, { operation, errorCodeHeader }),
      );
      if (Predicate.isTagged(error.reason, "ApiRateLimited")) {
        return yield* new VercelApiError({
          operation: error.operation,
          errorCode: error.errorCode,
          reason: new ApiRateLimited({
            message: error.reason.message,
            retryAfter: retryAfterFromHeader(header(response, "retry-after"), now),
          }),
        });
      }
      return yield* error;
    });

    const drain = (response: Response) => Effect.ignore(response.text);

    const readJson = <A>(
      operation: string,
      response: Response,
      schema: Schema.Codec<A, string>,
    ): Effect.Effect<A, VercelApiError> =>
      Effect.flatMap(
        Effect.catch(response.text, (error) =>
          vercelApiErrorFromHttpClientError(error, { operation }),
        ),
        (text) =>
          Effect.mapError(Schema.decodeUnknownEffect(schema)(text), (error) =>
            unexpected(operation, response.status, `Invalid response body: ${error.message}`),
          ),
      );

    const toReceivedMessage = Effect.fnUntraced(function* (
      part: QueuePartHeaders,
      body: Uint8Array,
      location: Pick<MessageHandle, "topic" | "consumerGroup" | "region">,
    ): Effect.fn.Return<ReceivedMessage, MessageCorrupted> {
      const corrupted = (message: string) =>
        new MessageCorrupted({ messageId: part.messageId, message });
      const createdAt = yield* Option.match(parseDate(part.timestamp), {
        onNone: () => Effect.fail(corrupted(`Invalid Vqs-Timestamp: ${part.timestamp}`)),
        onSome: Effect.succeed,
      });
      const expiresAt = yield* Option.match(part.expiresAt, {
        onNone: () => Effect.succeed(DateTime.addDuration(createdAt, defaultRetention)),
        onSome: (raw) =>
          Option.match(parseDate(raw), {
            onNone: () => Effect.fail(corrupted(`Invalid Vqs-Expires-At: ${raw}`)),
            onSome: Effect.succeed,
          }),
      });
      const messageId = MessageId.make(part.messageId);
      return new ReceivedMessage({
        handle: new MessageHandle({
          ...location,
          messageId,
          receiptHandle: ReceiptHandle.make(part.receiptHandle),
        }),
        metadata: new MessageMetadata({
          ...location,
          messageId,
          deliveryCount: part.deliveryCount,
          createdAt,
          expiresAt,
          ...Option.match(part.handoffCount, {
            onNone: () => ({}),
            onSome: (experimentalHandoffCount) => ({ experimentalHandoffCount }),
          }),
        }),
        contentType: part.contentType,
        body,
      });
    });

    const multipartParts = (
      operation: string,
      response: Response,
    ): Stream.Stream<MultipartPart, VercelApiError> =>
      Option.match(
        Option.flatMap(
          Option.fromUndefinedOr(header(response, "content-type")),
          boundaryFromContentType,
        ),
        {
          onNone: () =>
            Stream.fail(
              unexpected(
                operation,
                response.status,
                "Expected a multipart/mixed response with a boundary",
              ),
            ),
          onSome: (boundary) =>
            response.stream.pipe(
              decodeMultipartMixed(boundary),
              Stream.catchTags({
                HttpClientError: (error: HttpClientError.HttpClientError) =>
                  Stream.fromEffect(vercelApiErrorFromHttpClientError(error, { operation })),
                MultipartMixedError: (error) =>
                  Stream.fail(unexpected(operation, response.status, error.message)),
              }),
            ),
        },
      );

    const consumerHeaders = (
      visibilityTimeout: Duration.Input | undefined,
      extra: Readonly<Record<string, string>>,
    ) => {
      const headers = new HeaderSet({ accept: "multipart/mixed" });
      for (const [name, value] of Object.entries(config.headers)) headers.set(name, value);
      if (visibilityTimeout !== undefined) {
        headers.set("vqs-visibility-timeout-seconds", String(wholeSeconds(visibilityTimeout)));
      }
      for (const [name, value] of Object.entries(extra)) headers.set(name, value);
      return headers.toRecord();
    };

    const send = Effect.fn("QueueApi.send")(function* (
      topic: TopicName,
      message: OutgoingMessage,
    ): Effect.fn.Return<SendResult, QueueSendError> {
      const operation = "QueueApi.send";
      const request = HttpClientRequest.post(topicPath(topic)).pipe(
        HttpClientRequest.setHeaders(messageHeaders(config.headers, message).toRecord()),
        deploymentHeader(config.pinSends),
        HttpClientRequest.bodyUint8Array(message.body, message.contentType),
      );
      const response = yield* execute(operation, config.region, request);
      if (response.status < 200 || response.status > 299) {
        if (
          response.status === 502 &&
          header(response, errorCodeHeader) === "consumer_discovery_failed"
        ) {
          const body = yield* readErrorBody(response);
          return yield* new ConsumerDiscoveryFailed({
            message: body.message || "Consumer discovery failed",
          });
        }
        return yield* failCommon(operation, response);
      }
      if (response.status === 202) {
        yield* drain(response);
        return SendResult.Deferred();
      }
      const { messageId } = yield* readJson(operation, response, SendResponse);
      if (messageId === null) return SendResult.Deferred();
      if (messageId === "") {
        return yield* unexpected(operation, response.status, "Empty messageId in response");
      }
      return SendResult.Sent({ messageId: MessageId.make(messageId) });
    });

    const sendBatch = Effect.fn("QueueApi.sendBatch")(function* (
      topic: TopicName,
      messages: Arr.NonEmptyReadonlyArray<OutgoingMessage>,
    ): Effect.fn.Return<ReadonlyArray<BatchSendResult>, QueueSendBatchError> {
      const operation = "QueueApi.sendBatch";
      if (messages.length === 0 || messages.length > maxBatchSize) {
        return yield* new BatchSizeOutOfRange({ size: messages.length, maximum: maxBatchSize });
      }
      const boundary = `vqs-${crypto.randomUUID()}`;
      const body = encodeMultipartMixed(
        boundary,
        messages.map((message) => ({
          headers: messageHeaders(config.headers, message).sorted(),
          body: message.body,
        })),
      );
      const request = HttpClientRequest.post(topicPath(topic, "batch")).pipe(
        HttpClientRequest.setHeaders(config.headers),
        deploymentHeader(config.pinSends),
        HttpClientRequest.bodyUint8Array(body, `multipart/mixed; boundary=${boundary}`),
      );
      const response = yield* execute(operation, config.region, request);
      if (response.status < 200 || response.status > 299) {
        return yield* failCommon(operation, response);
      }
      const { results } = yield* readJson(operation, response, BatchResponse);
      if (results.length !== messages.length) {
        return yield* unexpected(
          operation,
          response.status,
          `Invalid batch response: expected ${messages.length} results, received ${results.length}`,
        );
      }
      return results.map((result): BatchSendResult =>
        "messageId" in result
          ? BatchSendResult.Sent({ messageId: result.messageId })
          : "statusCode" in result
            ? BatchSendResult.Failed({
                status: result.statusCode,
                message: result.error,
                retryable: result.retryable,
              })
            : BatchSendResult.Deferred(),
      );
    });

    const receive = Effect.fn("QueueApi.receive")(function* (
      topic: TopicName,
      consumerGroup: ConsumerGroupName,
      options: ReceiveOptions = {},
    ): Effect.fn.Return<ReadonlyArray<ReceivedMessage>, QueueRequestError | MessageCorrupted> {
      const operation = "QueueApi.receive";
      const region = options.region ?? config.region;
      const request = HttpClientRequest.post(topicPath(topic, "consumer", consumerGroup)).pipe(
        HttpClientRequest.setHeaders(
          consumerHeaders(options.visibilityTimeout, {
            ...(options.limit === undefined ? {} : { "vqs-max-messages": String(options.limit) }),
            ...(options.cursorFallback === undefined
              ? {}
              : { "vqs-cursor-fallback": options.cursorFallback }),
          }),
        ),
        deploymentHeader(true),
      );
      const response = yield* execute(operation, region, request);
      if (response.status === 204) {
        yield* drain(response);
        return [];
      }
      if (response.status < 200 || response.status > 299) {
        return yield* failCommon(operation, response);
      }
      const location = { topic, consumerGroup, region };
      const messages = yield* multipartParts(operation, response).pipe(
        Stream.mapEffect((part) =>
          Option.match(queuePartHeaders(part.headers), {
            onNone: () =>
              Effect.as(
                Effect.logWarning("Missing required queue headers in multipart part"),
                Option.none<ReceivedMessage>(),
              ),
            onSome: (headers) =>
              toReceivedMessage(headers, part.body, location).pipe(
                Effect.map(Option.some),
                Effect.catchTag("MessageCorrupted", (error) =>
                  Effect.as(
                    Effect.logWarning(
                      `Skipping corrupted message ${error.messageId}: ${error.message}`,
                    ),
                    Option.none<ReceivedMessage>(),
                  ),
                ),
              ),
          }),
        ),
        Stream.runCollect,
      );
      return Arr.getSomes(messages);
    });

    const receiveById = Effect.fn("QueueApi.receiveById")(function* (
      topic: TopicName,
      consumerGroup: ConsumerGroupName,
      messageId: MessageId,
      options: ReceiveByIdOptions = {},
    ): Effect.fn.Return<ReceivedMessage, QueueReceiveByIdError> {
      const operation = "QueueApi.receiveById";
      const region = options.region ?? config.region;
      const request = HttpClientRequest.post(
        topicPath(topic, "consumer", consumerGroup, "id", messageId),
      ).pipe(
        HttpClientRequest.setHeaders(consumerHeaders(options.visibilityTimeout, {})),
        deploymentHeader(true),
      );
      const response = yield* execute(operation, region, request);
      if (response.status < 200 || response.status > 299) {
        const body = yield* readErrorBody(response);
        if (response.status === 404) return yield* new MessageNotFound({ messageId });
        if (response.status === 409) {
          const now = yield* Clock.currentTimeMillis;
          return yield* new MessageNotAvailable({
            messageId,
            reason: Option.match(body.originalMessageId, {
              onNone: () =>
                new MessageLocked({
                  retryAfter: retryAfterFromHeader(header(response, "retry-after"), now),
                }),
              onSome: (original) =>
                new MessageUnavailable({
                  message: `This message was a duplicate - use originalMessageId: ${original}`,
                }),
            }),
          });
        }
        if (response.status === 410) return yield* new MessageAlreadyProcessed({ messageId });
        return yield* failCommon(operation, response);
      }
      const first = yield* Stream.runHead(multipartParts(operation, response));
      if (Option.isNone(first)) return yield* new MessageNotFound({ messageId });
      const headers = queuePartHeaders(first.value.headers);
      if (Option.isNone(headers)) {
        return yield* new MessageCorrupted({
          messageId,
          message: "Missing required queue headers in response",
        });
      }
      return yield* toReceivedMessage(headers.value, first.value.body, {
        topic,
        consumerGroup,
        region,
      });
    });

    const leaseRequest = (
      operation: string,
      handle: MessageHandle,
      request: HttpClientRequest.HttpClientRequest,
      defaultMessage: string,
      coalesced: boolean,
    ) =>
      Effect.gen(function* () {
        const response = yield* execute(operation, handle.region, request);
        if (response.status >= 200 && response.status <= 299) return response;
        const body = yield* readErrorBody(response);
        if (response.status === 404) {
          return yield* new MessageNotFound({ messageId: handle.messageId });
        }
        if (response.status === 409) {
          const count = coalesced
            ? coalescedPendingCount(
                header(response, errorCodeHeader),
                header(response, "vqs-experimental-coalesced"),
                body.text,
              )
            : Option.none();
          return yield* new MessageNotAvailable({
            messageId: handle.messageId,
            reason: Option.match(count, {
              onNone: () => new MessageUnavailable({ message: body.message || defaultMessage }),
              onSome: (coalescedCount) => new ConcurrencyCoalescedPending({ coalescedCount }),
            }),
          });
        }
        return yield* failCommon(operation, response);
      }).pipe(Effect.retry(leaseRetry));

    const leasePath = (handle: MessageHandle) =>
      topicPath(handle.topic, "consumer", handle.consumerGroup, "lease", handle.receiptHandle);

    const notAvailableMessage =
      "Invalid receipt handle, message not in correct state, or already processed";

    const acknowledge = Effect.fn("QueueApi.acknowledge")(function* (
      handle: MessageHandle,
      options: { readonly experimentalIfCoalesced?: number } = {},
    ): Effect.fn.Return<void, QueueLeaseError> {
      const ifCoalesced = options.experimentalIfCoalesced;
      const request = HttpClientRequest.delete(leasePath(handle)).pipe(
        HttpClientRequest.setHeaders(config.headers),
        deploymentHeader(true),
        HttpClientRequest.setHeaders(
          ifCoalesced !== undefined && ifCoalesced > 0
            ? { "vqs-experimental-if-coalesced": String(ifCoalesced) }
            : {},
        ),
      );
      const response = yield* leaseRequest(
        "QueueApi.acknowledge",
        handle,
        request,
        notAvailableMessage,
        true,
      );
      yield* drain(response);
    });

    const changeVisibility = Effect.fn("QueueApi.changeVisibility")(function* (
      handle: MessageHandle,
      visibilityTimeout: Duration.Input,
      options: { readonly experimentalHandoff?: boolean } = {},
    ): Effect.fn.Return<Option.Option<HandoffOutcome>, QueueLeaseError> {
      const headers = new HeaderSet({ "content-type": "application/json" });
      for (const [name, value] of Object.entries(config.headers)) headers.set(name, value);
      const request = HttpClientRequest.patch(leasePath(handle)).pipe(
        HttpClientRequest.setHeaders(headers.toRecord()),
        deploymentHeader(true),
        HttpClientRequest.setHeaders(
          options.experimentalHandoff === true ? { "vqs-experimental-handoff": "1" } : {},
        ),
        HttpClientRequest.bodyText(
          JSON.stringify({ visibilityTimeoutSeconds: wholeSeconds(visibilityTimeout) }),
          headers.get("content-type") ?? "application/json",
        ),
      );
      const response = yield* leaseRequest(
        "QueueApi.changeVisibility",
        handle,
        request,
        notAvailableMessage,
        false,
      );
      yield* drain(response);
      return decodeHandoffOutcome(header(response, "vqs-experimental-handoff"));
    });

    return QueueApi.of({
      send,
      sendBatch,
      receive,
      receiveById,
      acknowledge,
      changeVisibility,
    });
  }),
);
