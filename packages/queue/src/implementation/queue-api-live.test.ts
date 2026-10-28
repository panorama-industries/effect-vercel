import type {
  TestHttpRequest,
  TestHttpResponse,
} from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import {
  ApiRateLimited,
  DeploymentId,
  OidcTokenUnavailable,
  VercelApiError,
  VercelOidc,
  VercelRegion,
  vercelOidcFromToken,
} from "@panorama-industries/effect-vercel-core";
import {
  TestHttpServer,
  TestHttpServerLive,
} from "@panorama-industries/effect-vercel-core/testing";
import { DateTime, Duration, Effect, Layer, Logger, Option, Redacted, Ref, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";

import type { OutgoingMessage } from "../contracts/queue-api.ts";

import { BatchSendResult, QueueApi, ReceiveLimit, SendResult } from "../contracts/queue-api.ts";
import { QueueAuth, QueueConfig } from "../contracts/queue-config.ts";
import {
  BatchSizeOutOfRange,
  ConcurrencyCoalescedPending,
  ConcurrencyKey,
  ConsumerGroupName,
  IdempotencyKey,
  MessageHandle,
  MessageId,
  MessageLocked,
  MessageNotAvailable,
  MessageUnavailable,
  ReceiptHandle,
  TopicName,
} from "../contracts/queue-domain.ts";
import { encodeMultipartMixed } from "../internal/multipart.ts";
import { userAgent } from "../internal/version.ts";
import { QueueApiLive } from "./queue-api-live.ts";

const orders = TopicName.make("orders");
const workers = ConsumerGroupName.make("workers");
const iad1 = VercelRegion.make("iad1");
const sfo1 = VercelRegion.make("sfo1");

type ConfigOverrides = Partial<QueueConfig["Service"]>;

const failingTransport = (failures: number) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const remaining = yield* Ref.make(failures);
      return HttpClient.mapRequestEffect(client, (request) =>
        Effect.flatMap(
          Ref.getAndUpdate(remaining, (n) => n - 1),
          (left) =>
            left > 0
              ? Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request, description: "reset" }),
                  }),
                )
              : Effect.succeed(request),
        ),
      );
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

const testLayer = (
  overrides: ConfigOverrides = {},
  oidc: Layer.Layer<VercelOidc> = vercelOidcFromToken(Redacted.make("oidc-token")),
  http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
) => {
  const config = Layer.effect(
    QueueConfig,
    Effect.gen(function* () {
      const server = yield* TestHttpServer;
      return QueueConfig.of({
        region: iad1,
        baseUrl: (region) => new URL(`${server.url}/${region}/`),
        auth: QueueAuth.Token({ token: Redacted.make("secret") }),
        deploymentId: Option.some(DeploymentId.make("dpl_1")),
        pinSends: true,
        headers: {},
        ...overrides,
      });
    }),
  );
  return QueueApiLive.pipe(
    Layer.provideMerge(config),
    Layer.provideMerge(TestHttpServerLive()),
    Layer.provide(oidc),
    Layer.provide(http),
  );
};

const message = (overrides: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  body: new TextEncoder().encode('{"id":1}'),
  contentType: "application/json",
  ...overrides,
});

const handle = new MessageHandle({
  topic: orders,
  consumerGroup: workers,
  messageId: MessageId.make("msg_1"),
  receiptHandle: ReceiptHandle.make("rh/1"),
  region: sfo1,
});

const lastRequest = Effect.gen(function* () {
  const requests = yield* (yield* TestHttpServer).requests;
  const request = requests.at(-1);
  assert.isDefined(request);
  return request as TestHttpRequest;
});

const enqueue = (...responses: ReadonlyArray<TestHttpResponse>) =>
  Effect.flatMap(Effect.service(TestHttpServer), (server) => server.enqueue(...responses));

const requestCount = Effect.map(
  Effect.flatMap(Effect.service(TestHttpServer), (server) => server.requests),
  (requests) => requests.length,
);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const notAvailableReason = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.instanceOf(error, MessageNotAvailable);
    return (error as MessageNotAvailable).reason;
  });

const apiErrorReason = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.instanceOf(error, VercelApiError);
    return (error as VercelApiError).reason;
  });

const receivedPart = (
  headers: Record<string, string>,
  body = '{"id":1}',
): { headers: Array<[string, string]>; body: Uint8Array } => ({
  headers: Object.entries(headers),
  body: new TextEncoder().encode(body),
});

const multipartResponse = (
  parts: ReadonlyArray<{ headers: Array<[string, string]>; body: Uint8Array }>,
  chunkSize?: number,
): TestHttpResponse => {
  const body = encodeMultipartMixed("b0undary", parts);
  return {
    status: 200,
    headers: { "content-type": 'multipart/mixed; boundary="b0undary"' },
    body:
      chunkSize === undefined
        ? body
        : Stream.fromIterable(
            Array.from({ length: Math.ceil(body.length / chunkSize) }, (_, i) =>
              body.slice(i * chunkSize, (i + 1) * chunkSize),
            ),
          ),
  };
};

const fullHeaders = {
  "content-type": "application/json",
  "vqs-message-id": "msg_1",
  "vqs-receipt-handle": "rh_1",
  "vqs-delivery-count": "2",
  "vqs-timestamp": "2026-01-01T00:00:00.000Z",
  "vqs-expires-at": "2026-01-02T00:00:00.000Z",
};

describe("QueueApiLive", () => {
  describe("send", () => {
    it.effect("posts the body with message headers, auth and deployment", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(json(200, { messageId: "msg_1" }));
        const result = yield* api.send(
          orders,
          message({
            idempotencyKey: IdempotencyKey.make("idem"),
            retention: Duration.hours(1),
            delay: Duration.millis(1500),
            experimentalConcurrencyKey: ConcurrencyKey.make("tenant-1"),
            headers: {
              "X-Trace": "abc",
              Authorization: "nope",
              "Content-Type": "text/plain",
              "Vqs-Delay-Seconds": "99",
            },
          }),
        );
        assert.deepStrictEqual(result, SendResult.Sent({ messageId: MessageId.make("msg_1") }));
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.url, "/iad1/api/v3/topic/orders");
        assert.strictEqual(request.text, '{"id":1}');
        assert.strictEqual(request.headers["authorization"], "Bearer secret");
        assert.strictEqual(request.headers["user-agent"], userAgent);
        assert.strictEqual(request.headers["content-type"], "application/json");
        assert.strictEqual(request.headers["vqs-idempotency-key"], "idem");
        assert.strictEqual(request.headers["vqs-retention-seconds"], "3600");
        assert.strictEqual(request.headers["vqs-delay-seconds"], "2");
        assert.strictEqual(request.headers["vqs-experimental-concurrency-key"], "tenant-1");
        assert.strictEqual(request.headers["vqs-deployment-id"], "dpl_1");
        assert.strictEqual(request.headers["x-trace"], "abc");
        assert.strictEqual(request.headers["vqs-client-ts"], "1970-01-01T00:00:00.000Z");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("adds config headers below message headers and omits unpinned deployments", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(json(201, { messageId: "msg_1" }));
        yield* api.send(orders, message({ headers: { "x-team": "message" } }));
        const request = yield* lastRequest;
        assert.strictEqual(request.headers["x-team"], "message");
        assert.strictEqual(request.headers["x-extra"], "config");
        assert.strictEqual(request.headers["authorization"], "Bearer secret");
        assert.isUndefined(request.headers["vqs-deployment-id"]);
      }).pipe(
        Effect.provide(
          testLayer({
            pinSends: false,
            headers: { "x-team": "config", "x-extra": "config", authorization: "custom" },
          }),
        ),
      ),
    );

    it.effect("reports deferred sends for 202 and a null message id", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 202 }, json(200, { messageId: null }));
        assert.deepStrictEqual(yield* api.send(orders, message()), SendResult.Deferred());
        assert.deepStrictEqual(yield* api.send(orders, message()), SendResult.Deferred());
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("maps consumer discovery and registry failures", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          json(502, { error: "gone" }, { "vqs-error-code": "consumer_discovery_failed" }),
          { status: 503, headers: { "vqs-error-code": "consumer_registry_not_configured" } },
          { status: 502 },
        );
        const discovery = yield* Effect.flip(api.send(orders, message()));
        assert.strictEqual(discovery._tag, "ConsumerDiscoveryFailed");
        assert.strictEqual(discovery.message, "gone");
        const registry = yield* Effect.flip(api.send(orders, message()));
        assert.strictEqual(registry._tag, "ConsumerRegistryNotConfigured");
        assert.strictEqual(registry.message, "Consumer registry not configured");
        const reason = yield* apiErrorReason(api.send(orders, message()));
        assert.strictEqual(reason._tag, "ApiServerError");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("maps other statuses to VercelApiError reasons without retrying", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        const cases: ReadonlyArray<readonly [TestHttpResponse, string]> = [
          [json(400, { error: "bad" }), "ApiBadRequest"],
          [{ status: 401 }, "ApiUnauthorized"],
          [{ status: 403 }, "ApiForbidden"],
          [{ status: 413 }, "ApiPayloadTooLarge"],
          [{ status: 429, headers: { "retry-after": "0" } }, "ApiRateLimited"],
          [{ status: 500 }, "ApiServerError"],
          [{ status: 503 }, "ApiServerError"],
          [{ status: 418 }, "ApiUnexpectedResponse"],
          [{ status: 200, body: "not json" }, "ApiUnexpectedResponse"],
        ];
        for (const [response, tag] of cases) {
          yield* enqueue(response);
          const reason = yield* apiErrorReason(api.send(orders, message()));
          assert.strictEqual(reason._tag, tag);
        }
        assert.strictEqual(yield* requestCount, cases.length);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("keeps the error code and SDK Retry-After parsing", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({
          status: 429,
          headers: { "retry-after": "1.5", "vqs-error-code": "throttled" },
        });
        const error = yield* Effect.flip(api.send(orders, message()));
        assert.instanceOf(error, VercelApiError);
        const apiError = error as VercelApiError;
        assert.deepStrictEqual(apiError.errorCode, Option.some("throttled"));
        assert.strictEqual(apiError.operation, "QueueApi.send");
        assert.instanceOf(apiError.reason, ApiRateLimited);
        assert.deepStrictEqual(
          (apiError.reason as ApiRateLimited).retryAfter,
          Option.some(Duration.seconds(1.5)),
        );
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("authenticates with the OIDC token and maps a missing token", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(json(200, { messageId: "msg_1" }));
        yield* api.send(orders, message());
        assert.strictEqual((yield* lastRequest).headers["authorization"], "Bearer oidc-token");
      }).pipe(Effect.provide(testLayer({ auth: QueueAuth.Oidc() }))),
    );

    it.effect("fails with ApiUnauthorized when no OIDC token is available", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        const reason = yield* apiErrorReason(api.send(orders, message()));
        assert.strictEqual(reason._tag, "ApiUnauthorized");
        assert.strictEqual(yield* requestCount, 0);
      }).pipe(
        Effect.provide(
          testLayer(
            { auth: QueueAuth.Oidc() },
            Layer.succeed(
              VercelOidc,
              VercelOidc.of({ token: Effect.fail(new OidcTokenUnavailable({ message: "none" })) }),
            ),
          ),
        ),
      ),
    );
  });

  describe("sendBatch", () => {
    it.effect("posts multipart/mixed with one part per message and maps results", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          json(200, {
            results: [
              { status: "sent", messageId: "msg_1" },
              { status: "deferred", messageId: null },
              { status: "failed", statusCode: 400, error: "too big", retryable: false },
            ],
          }),
        );
        const results = yield* api.sendBatch(orders, [
          message({ idempotencyKey: IdempotencyKey.make("a"), headers: { "X-B": "1" } }),
          message({ body: new Uint8Array([0, 1]), contentType: "application/octet-stream" }),
          message({ delay: "5 seconds" }),
        ]);
        assert.deepStrictEqual(results, [
          BatchSendResult.Sent({ messageId: MessageId.make("msg_1") }),
          BatchSendResult.Deferred(),
          BatchSendResult.Failed({ status: 400, message: "too big", retryable: false }),
        ]);
        const request = yield* lastRequest;
        assert.strictEqual(request.url, "/iad1/api/v3/topic/orders/batch");
        assert.strictEqual(request.headers["vqs-deployment-id"], "dpl_1");
        assert.strictEqual(request.headers["x-config"], "1");
        const boundary = /^multipart\/mixed; boundary=(vqs-[0-9a-f-]{36})$/.exec(
          request.headers["content-type"] ?? "",
        )?.[1];
        assert.isDefined(boundary);
        assert.strictEqual(
          request.text,
          [
            `--${boundary}`,
            "content-type: application/json",
            "vqs-idempotency-key: a",
            "x-b: 1",
            "x-config: 1",
            "",
            '{"id":1}',
            `--${boundary}`,
            "content-type: application/octet-stream",
            "x-config: 1",
            "",
            "\u0000\u0001",
            `--${boundary}`,
            "content-type: application/json",
            "vqs-delay-seconds: 5",
            "x-config: 1",
            "",
            '{"id":1}',
            `--${boundary}--`,
            "",
          ].join("\r\n"),
        );
      }).pipe(Effect.provide(testLayer({ headers: { "X-Config": "1" } }))),
    );

    it.effect("rejects a result count that does not match the batch", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(json(200, { results: [] }));
        const reason = yield* apiErrorReason(api.sendBatch(orders, [message()]));
        assert.strictEqual(reason._tag, "ApiUnexpectedResponse");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("rejects more than 100 messages without sending a request", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        const messages = Array.from({ length: 101 }, () => message());
        const error = yield* Effect.flip(api.sendBatch(orders, [message(), ...messages.slice(1)]));
        assert.deepStrictEqual(error, new BatchSizeOutOfRange({ size: 101, maximum: 100 }));
        assert.strictEqual(yield* requestCount, 0);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("treats a discovery failure like any server error, as the SDK does", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 502, headers: { "vqs-error-code": "consumer_discovery_failed" } });
        const reason = yield* apiErrorReason(api.sendBatch(orders, [message()]));
        assert.strictEqual(reason._tag, "ApiServerError");
      }).pipe(Effect.provide(testLayer())),
    );
  });

  describe("receive", () => {
    it.effect("asks for multipart messages and parses each part", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          multipartResponse(
            [
              receivedPart(fullHeaders),
              receivedPart(
                {
                  "vqs-message-id": "msg_2",
                  "vqs-receipt-handle": "rh_2",
                  "vqs-timestamp": "2026-01-01T00:00:00.000Z",
                  "vqs-experimental-handoff-count": "3",
                },
                "raw",
              ),
            ],
            7,
          ),
        );
        const messages = yield* api.receive(orders, workers, {
          limit: ReceiveLimit.make(5),
          visibilityTimeout: "30 seconds",
          cursorFallback: "earliest",
          region: sfo1,
        });
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.url, "/sfo1/api/v3/topic/orders/consumer/workers");
        assert.strictEqual(request.headers["accept"], "multipart/mixed");
        assert.strictEqual(request.headers["vqs-max-messages"], "5");
        assert.strictEqual(request.headers["vqs-visibility-timeout-seconds"], "30");
        assert.strictEqual(request.headers["vqs-cursor-fallback"], "earliest");
        assert.strictEqual(request.headers["vqs-deployment-id"], "dpl_1");
        assert.strictEqual(messages.length, 2);
        const [first, second] = messages;
        assert.strictEqual(first?.handle.receiptHandle, "rh_1");
        assert.strictEqual(first?.handle.region, sfo1);
        assert.strictEqual(first?.metadata.deliveryCount, 2);
        assert.strictEqual(first?.contentType, "application/json");
        assert.strictEqual(new TextDecoder().decode(first?.body), '{"id":1}');
        assert.deepStrictEqual(
          first?.metadata.expiresAt,
          DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
        );
        assert.strictEqual(second?.contentType, "application/octet-stream");
        assert.strictEqual(second?.metadata.deliveryCount, 0);
        assert.strictEqual(second?.metadata.experimentalHandoffCount, 3);
        assert.deepStrictEqual(
          second?.metadata.expiresAt,
          DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
        );
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("returns no messages for 204 and sends no optional headers", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 204 });
        assert.deepStrictEqual(yield* api.receive(orders, workers), []);
        const request = yield* lastRequest;
        assert.strictEqual(request.url, "/iad1/api/v3/topic/orders/consumer/workers");
        assert.isUndefined(request.headers["vqs-max-messages"]);
        assert.isUndefined(request.headers["vqs-deployment-id"]);
      }).pipe(Effect.provide(testLayer({ deploymentId: Option.none(), pinSends: false }))),
    );

    it.effect("warns about and skips parts without queue headers", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        const warnings = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") Effect.runSync(Ref.update(warnings, (all) => [...all, message]));
        });
        yield* enqueue(
          multipartResponse([
            receivedPart({ "vqs-message-id": "msg_0" }),
            receivedPart({ ...fullHeaders, "vqs-delivery-count": "x" }),
            receivedPart(fullHeaders),
          ]),
        );
        const messages = yield* api
          .receive(orders, workers)
          .pipe(Effect.provide(Logger.layer([logger])));
        assert.strictEqual(messages.length, 1);
        assert.strictEqual((yield* Ref.get(warnings)).length, 2);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("warns about and skips parts with unreadable dates, keeping the rest", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        const warnings = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") Effect.runSync(Ref.update(warnings, (all) => [...all, message]));
        });
        yield* enqueue(
          multipartResponse([
            receivedPart({ ...fullHeaders, "vqs-timestamp": "yesterday" }),
            receivedPart({ ...fullHeaders, "vqs-expires-at": "never" }),
            receivedPart(fullHeaders),
          ]),
        );
        const messages = yield* api
          .receive(orders, workers)
          .pipe(Effect.provide(Logger.layer([logger])));
        assert.strictEqual(messages.length, 1);
        assert.strictEqual((yield* Ref.get(warnings)).length, 2);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("fails with ApiUnexpectedResponse for malformed multipart bodies", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          { status: 200, headers: { "content-type": "application/json" }, body: "{}" },
          {
            status: 200,
            headers: { "content-type": "multipart/mixed; boundary=x" },
            body: "--x\r\nvqs-message-id: a\r\n\r\ntruncated",
          },
        );
        assert.strictEqual(
          (yield* apiErrorReason(api.receive(orders, workers)))._tag,
          "ApiUnexpectedResponse",
        );
        assert.strictEqual(
          (yield* apiErrorReason(api.receive(orders, workers)))._tag,
          "ApiUnexpectedResponse",
        );
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("maps error statuses and does not retry", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          { status: 429, headers: { "retry-after": "0" } },
          { status: 503, headers: { "vqs-error-code": "consumer_registry_not_configured" } },
        );
        assert.strictEqual(
          (yield* apiErrorReason(api.receive(orders, workers)))._tag,
          "ApiRateLimited",
        );
        assert.strictEqual(
          (yield* Effect.flip(api.receive(orders, workers)))._tag,
          "ConsumerRegistryNotConfigured",
        );
        assert.strictEqual(yield* requestCount, 2);
      }).pipe(Effect.provide(testLayer())),
    );
  });

  describe("receiveById", () => {
    const id = MessageId.make("msg/1");

    it.effect("leases one message by id", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(multipartResponse([receivedPart(fullHeaders), receivedPart(fullHeaders)]));
        const received = yield* api.receiveById(orders, workers, id, {
          visibilityTimeout: "1 minute",
        });
        assert.strictEqual(received.handle.messageId, "msg_1");
        const request = yield* lastRequest;
        assert.strictEqual(request.url, "/iad1/api/v3/topic/orders/consumer/workers/id/msg%2F1");
        assert.strictEqual(request.headers["accept"], "multipart/mixed");
        assert.strictEqual(request.headers["vqs-visibility-timeout-seconds"], "60");
        assert.strictEqual(request.headers["vqs-deployment-id"], "dpl_1");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("maps domain statuses", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          { status: 404 },
          { status: 409, headers: { "retry-after": "7" } },
          json(409, { originalMessageId: "msg_0" }),
          { status: 410 },
          multipartResponse([]),
          multipartResponse([receivedPart({ "vqs-message-id": "msg_1" })]),
          { status: 403 },
        );
        const receive = api.receiveById(orders, workers, id);
        assert.strictEqual((yield* Effect.flip(receive))._tag, "MessageNotFound");
        assert.deepStrictEqual(
          yield* notAvailableReason(receive),
          new MessageLocked({ retryAfter: Option.some(Duration.seconds(7)) }),
        );
        assert.deepStrictEqual(
          yield* notAvailableReason(receive),
          new MessageUnavailable({
            message: "This message was a duplicate - use originalMessageId: msg_0",
          }),
        );
        assert.strictEqual((yield* Effect.flip(receive))._tag, "MessageAlreadyProcessed");
        assert.strictEqual((yield* Effect.flip(receive))._tag, "MessageNotFound");
        assert.strictEqual((yield* Effect.flip(receive))._tag, "MessageCorrupted");
        assert.strictEqual((yield* apiErrorReason(receive))._tag, "ApiForbidden");
      }).pipe(Effect.provide(testLayer())),
    );
  });

  describe("acknowledge", () => {
    it.effect("deletes the lease in the handle's region", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 204 }, { status: 200 });
        yield* api.acknowledge(handle);
        let request = yield* lastRequest;
        assert.strictEqual(request.method, "DELETE");
        assert.strictEqual(request.url, "/sfo1/api/v3/topic/orders/consumer/workers/lease/rh%2F1");
        assert.strictEqual(request.headers["vqs-deployment-id"], "dpl_1");
        assert.isUndefined(request.headers["vqs-experimental-if-coalesced"]);
        yield* api.acknowledge(handle, { experimentalIfCoalesced: 2 });
        request = yield* lastRequest;
        assert.strictEqual(request.headers["vqs-experimental-if-coalesced"], "2");
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("maps not found, coalesced and unavailable leases", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          { status: 404 },
          {
            status: 409,
            headers: {
              "vqs-error-code": "concurrency_coalesced_pending",
              "vqs-experimental-coalesced": "3",
            },
          },
          json(409, { coalescedCount: 4 }, { "vqs-error-code": "concurrency_coalesced_pending" }),
          json(409, { error: "stale" }),
        );
        assert.strictEqual((yield* Effect.flip(api.acknowledge(handle)))._tag, "MessageNotFound");
        for (const coalescedCount of [3, 4]) {
          assert.deepStrictEqual(
            yield* notAvailableReason(api.acknowledge(handle)),
            new ConcurrencyCoalescedPending({ coalescedCount }),
          );
        }
        assert.deepStrictEqual(
          yield* notAvailableReason(api.acknowledge(handle)),
          new MessageUnavailable({ message: "stale" }),
        );
      }).pipe(Effect.provide(testLayer())),
    );

    it.live("retries rate limits that carry Retry-After, up to 3 attempts", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 429, headers: { "retry-after": "0" } }, { status: 204 });
        yield* api.acknowledge(handle);
        assert.strictEqual(yield* requestCount, 2);
        yield* enqueue(
          { status: 429, headers: { "retry-after": "0" } },
          { status: 429, headers: { "retry-after": "0" } },
          { status: 429, headers: { "retry-after": "0" } },
          { status: 204 },
        );
        const reason = yield* apiErrorReason(api.acknowledge(handle));
        assert.strictEqual(reason._tag, "ApiRateLimited");
        assert.strictEqual(yield* requestCount, 5);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("does not retry 429 without Retry-After, 5xx or client errors", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 429 }, { status: 500 }, { status: 400 }, { status: 204 });
        assert.strictEqual((yield* apiErrorReason(api.acknowledge(handle)))._tag, "ApiRateLimited");
        assert.strictEqual((yield* apiErrorReason(api.acknowledge(handle)))._tag, "ApiServerError");
        assert.strictEqual((yield* apiErrorReason(api.acknowledge(handle)))._tag, "ApiBadRequest");
        assert.strictEqual(yield* requestCount, 3);
      }).pipe(Effect.provide(testLayer())),
    );

    it.live("retries network failures, up to 3 attempts", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 204 });
        yield* api.acknowledge(handle);
        assert.strictEqual(yield* requestCount, 1);
      }).pipe(Effect.provide(testLayer({}, undefined, failingTransport(2)))),
    );

    it.live("gives up after 3 network failures", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 204 });
        const reason = yield* apiErrorReason(api.acknowledge(handle));
        assert.strictEqual(reason._tag, "ApiNetworkFailure");
        yield* api.acknowledge(handle);
        assert.strictEqual(yield* requestCount, 1);
      }).pipe(Effect.provide(testLayer({}, undefined, failingTransport(3)))),
    );

    it.effect("does not retry sends or receives after a network failure", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        assert.strictEqual(
          (yield* apiErrorReason(api.send(orders, message())))._tag,
          "ApiNetworkFailure",
        );
        assert.strictEqual(
          (yield* apiErrorReason(api.receive(orders, workers)))._tag,
          "ApiNetworkFailure",
        );
        assert.strictEqual(yield* requestCount, 0);
      }).pipe(Effect.provide(testLayer({}, undefined, failingTransport(2)))),
    );
  });

  describe("changeVisibility", () => {
    it.effect("patches the lease with whole seconds and reads the handoff outcome", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          { status: 200, headers: { "vqs-experimental-handoff": "accepted" } },
          { status: 204, headers: { "vqs-experimental-handoff": "unknown" } },
        );
        const outcome = yield* api.changeVisibility(handle, "2500 millis", {
          experimentalHandoff: true,
        });
        assert.deepStrictEqual(outcome, Option.some("accepted"));
        const request = yield* lastRequest;
        assert.strictEqual(request.method, "PATCH");
        assert.strictEqual(request.url, "/sfo1/api/v3/topic/orders/consumer/workers/lease/rh%2F1");
        assert.strictEqual(request.headers["content-type"], "application/json");
        assert.strictEqual(request.headers["vqs-experimental-handoff"], "1");
        assert.strictEqual(request.text, '{"visibilityTimeoutSeconds":3}');
        assert.deepStrictEqual(yield* api.changeVisibility(handle, Duration.zero), Option.none());
        const release = yield* lastRequest;
        assert.strictEqual(release.text, '{"visibilityTimeoutSeconds":0}');
        assert.isUndefined(release.headers["vqs-experimental-handoff"]);
      }).pipe(Effect.provide(testLayer())),
    );

    it.effect("maps lease statuses", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue(
          { status: 404 },
          { status: 409, headers: { "vqs-error-code": "concurrency_coalesced_pending" } },
          { status: 401 },
        );
        const change = api.changeVisibility(handle, "1 second");
        assert.strictEqual((yield* Effect.flip(change))._tag, "MessageNotFound");
        assert.deepStrictEqual(
          yield* notAvailableReason(change),
          new MessageUnavailable({
            message: "Invalid receipt handle, message not in correct state, or already processed",
          }),
        );
        assert.strictEqual((yield* apiErrorReason(change))._tag, "ApiUnauthorized");
      }).pipe(Effect.provide(testLayer())),
    );

    it.live("retries rate limits that carry Retry-After", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        yield* enqueue({ status: 429, headers: { "retry-after": "0" } }, { status: 200 });
        yield* api.changeVisibility(handle, "1 second");
        assert.strictEqual(yield* requestCount, 2);
      }).pipe(Effect.provide(testLayer())),
    );
  });
});
