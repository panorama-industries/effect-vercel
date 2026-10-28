import type {
  TestHttpResponse,
  TestHttpServer,
} from "@panorama-industries/effect-vercel-core/testing";

import { assert, describe, it } from "@effect/vitest";
import { VercelRegion } from "@panorama-industries/effect-vercel-core";
import { DateTime, Effect, Option, Stream } from "effect";
import { afterAll, beforeAll, vi } from "vitest";

import type {
  BatchSendResult,
  OutgoingMessage,
  SendResult,
} from "../../src/contracts/queue-api.ts";
import type { ReceivedMessage } from "../../src/contracts/queue-domain.ts";
import type { Comparison, SdkMessage, Setup } from "./harness.ts";

import { QueueApi, ReceiveLimit } from "../../src/contracts/queue-api.ts";
import {
  ConcurrencyKey,
  ConsumerGroupName,
  IdempotencyKey,
  MessageHandle,
  MessageId,
  ReceiptHandle,
  TopicName,
} from "../../src/contracts/queue-domain.ts";
import { encodeMultipartMixed } from "../../src/internal/multipart.ts";
import { compare, defaultSetup, ourLayer, ourOutcome, sdkApi, sdkOutcome } from "./harness.ts";

const topic = "orders";
const group = "workers";
const orders = TopicName.make(topic);
const workers = ConsumerGroupName.make(group);
const payload = new TextEncoder().encode('{"id":1}');

const assertSame = <B>(result: Comparison<B>) => {
  assert.isDefined(result.sdkRequest, "the SDK sent no request");
  assert.deepStrictEqual(result.ourRequest, result.sdkRequest);
  assert.deepStrictEqual(result.ours, result.sdk);
};

const errorStatuses: ReadonlyArray<readonly [string, TestHttpResponse]> = [
  [
    "400",
    { status: 400, headers: { "content-type": "application/json" }, body: '{"error":"bad"}' },
  ],
  ["401", { status: 401 }],
  ["403", { status: 403, body: "denied" }],
  ["404", { status: 404 }],
  [
    "409",
    { status: 409, headers: { "content-type": "application/json" }, body: '{"error":"held"}' },
  ],
  ["409 locked", { status: 409, headers: { "retry-after": "12" } }],
  [
    "409 duplicate",
    {
      status: 409,
      headers: { "content-type": "application/json" },
      body: '{"originalMessageId":"msg_0"}',
    },
  ],
  [
    "409 coalesced (header)",
    {
      status: 409,
      headers: {
        "vqs-error-code": "concurrency_coalesced_pending",
        "vqs-experimental-coalesced": "2",
      },
    },
  ],
  [
    "409 coalesced (body)",
    {
      status: 409,
      headers: {
        "content-type": "application/json",
        "vqs-error-code": "concurrency_coalesced_pending",
      },
      body: '{"coalescedCount":5}',
    },
  ],
  [
    "409 coalesced count without code",
    { status: 409, headers: { "vqs-experimental-coalesced": "2" } },
  ],
  ["410", { status: 410 }],
  ["413", { status: 413 }],
  ["429", { status: 429 }],
  ["429 retry-after", { status: 429, headers: { "retry-after": "0" } }],
  ["500", { status: 500 }],
  ["502", { status: 502 }],
  [
    "502 consumer_discovery_failed",
    {
      status: 502,
      headers: {
        "content-type": "application/json",
        "vqs-error-code": "consumer_discovery_failed",
      },
      body: '{"error":{"message":"deployment gone"}}',
    },
  ],
  ["503", { status: 503 }],
  [
    "503 consumer_registry_not_configured",
    { status: 503, headers: { "vqs-error-code": "consumer_registry_not_configured" } },
  ],
  ["418", { status: 418 }],
];

const sentMessage = (overrides: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  body: payload,
  contentType: "application/octet-stream",
  ...overrides,
});

const sendResultWire = (result: SendResult) =>
  ({ messageId: "messageId" in result ? result.messageId : null }) as const;

const batchResultWire = (result: BatchSendResult): Record<string, unknown> =>
  "messageId" in result
    ? { status: "sent", messageId: result.messageId }
    : "retryable" in result
      ? {
          status: "failed",
          statusCode: result.status,
          error: result.message,
          retryable: result.retryable,
        }
      : { status: "deferred", messageId: null };

const sdkMessageWire = (message: SdkMessage) => ({
  messageId: message.messageId,
  receiptHandle: message.receiptHandle,
  deliveryCount: message.deliveryCount,
  createdAt: message.createdAt.toISOString(),
  expiresAt: (
    message.expiresAt ?? new Date(message.createdAt.getTime() + 86_400_000)
  ).toISOString(),
  contentType: message.contentType,
  handoffCount: message.experimental_handoffCount,
  body: Array.from(message.payload),
});

const ourMessageWire = (message: ReceivedMessage) => ({
  messageId: message.handle.messageId as string,
  receiptHandle: message.handle.receiptHandle as string,
  deliveryCount: message.metadata.deliveryCount,
  createdAt: DateTime.formatIso(message.metadata.createdAt),
  expiresAt: DateTime.formatIso(message.metadata.expiresAt),
  contentType: message.contentType,
  handoffCount: message.metadata.experimentalHandoffCount,
  body: Array.from(message.body),
});

const part = (headers: Record<string, string>, body: string | Uint8Array = '{"id":1}') => ({
  headers: Object.entries(headers),
  body: typeof body === "string" ? new TextEncoder().encode(body) : body,
});

const queueHeaders = (id: string, extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "vqs-message-id": id,
  "vqs-receipt-handle": `rh_${id}`,
  "vqs-delivery-count": "1",
  "vqs-timestamp": "2026-03-01T10:00:00.000Z",
  "vqs-expires-at": "2026-03-02T10:00:00.000Z",
  ...extra,
});

const multipart = (
  parts: ReadonlyArray<ReturnType<typeof part>>,
  chunkSize?: number,
): (() => TestHttpResponse) => {
  const body = encodeMultipartMixed("vqs-test-boundary", parts);
  return () => ({
    status: 200,
    headers: { "content-type": "multipart/mixed; boundary=vqs-test-boundary" },
    body: chunkSize === undefined ? body : Stream.fromIterable(chunked(body, chunkSize)),
  });
};

// mixpart rejects an epilogue that arrives in a later chunk than the closing delimiter, so the
// closing delimiter and its CRLF are always sent together.
const chunked = (body: Uint8Array, size: number): Array<Uint8Array> => {
  const tail = body.length - 32;
  return [
    ...Array.from({ length: Math.ceil(tail / size) }, (_, i) =>
      body.slice(i * size, Math.min(tail, (i + 1) * size)),
    ),
    body.slice(tail),
  ];
};

const handle = (region = "iad1") =>
  new MessageHandle({
    topic: orders,
    consumerGroup: workers,
    messageId: MessageId.make("msg_1"),
    receiptHandle: ReceiptHandle.make("rh/1"),
    region: VercelRegion.make(region),
  });

const withSetup =
  (setup: Setup) =>
  <A, E>(effect: Effect.Effect<A, E, QueueApi | TestHttpServer>) =>
    Effect.provide(effect, ourLayer(setup));

const run = withSetup(defaultSetup);

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("differential: @vercel/queue@0.10.0 vs QueueApiLive", () => {
  describe("send", () => {
    const sendBoth = (
      response: TestHttpResponse,
      message: OutgoingMessage = sentMessage(),
      sdkOptions: Record<string, unknown> = {},
      setup: Setup = defaultSetup,
    ) =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        return yield* compare(
          response,
          (server) =>
            sdkOutcome(
              () =>
                sdkApi(server, setup).sendMessage({
                  queueName: topic,
                  payload: Buffer.from(message.body),
                  ...sdkOptions,
                }),
              (value) => ({ messageId: value.messageId ?? null }),
            ),
          ourOutcome(api.send(orders, message), sendResultWire),
        );
      });

    it.live("sends identical requests with every option", () =>
      Effect.gen(function* () {
        const result = yield* sendBoth(
          {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"messageId":"m1"}',
          },
          sentMessage({
            idempotencyKey: IdempotencyKey.make("idem-1"),
            retention: "3600 seconds",
            delay: "30 seconds",
            experimentalConcurrencyKey: ConcurrencyKey.make("tenant"),
            headers: {
              "X-Request": "r1",
              authorization: "user",
              "Content-Type": "text/plain",
              "Vqs-Message-Id": "spoof",
              "x-custom": "message wins",
            },
          }),
          {
            idempotencyKey: "idem-1",
            retentionSeconds: 3600,
            delaySeconds: 30,
            experimental_concurrencyKey: "tenant",
            headers: {
              "X-Request": "r1",
              authorization: "user",
              "Content-Type": "text/plain",
              "Vqs-Message-Id": "spoof",
              "x-custom": "message wins",
            },
          },
        );
        assertSame(result);
        assert.deepStrictEqual(result.ours, { ok: { messageId: "m1" } });
      }).pipe(run),
    );

    it.live("omits the deployment when sends are unpinned", () => {
      const setup: Setup = { pinned: false, headers: {} };
      return Effect.gen(function* () {
        assertSame(
          yield* sendBoth(
            {
              status: 200,
              headers: { "content-type": "application/json" },
              body: '{"messageId":"m1"}',
            },
            sentMessage(),
            {},
            setup,
          ),
        );
      }).pipe(withSetup(setup));
    });

    it.live("agrees on deferred sends", () =>
      Effect.gen(function* () {
        assertSame(yield* sendBoth({ status: 202 }));
        assertSame(
          yield* sendBoth({
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"messageId":null}',
          }),
        );
      }).pipe(run),
    );

    it.live("agrees on every error status", () =>
      Effect.gen(function* () {
        for (const [name, response] of errorStatuses) {
          const result = yield* sendBoth(response);
          assert.deepStrictEqual(result.ours, result.sdk, name);
          assert.deepStrictEqual(result.ourRequest, result.sdkRequest, name);
        }
        const result = yield* sendBoth({ status: 200, body: "not json" });
        assert.deepStrictEqual(result.ours, result.sdk);
      }).pipe(run),
    );
  });

  describe("sendBatch", () => {
    const messages = [
      sentMessage({ idempotencyKey: IdempotencyKey.make("a"), headers: { "X-B": "b" } }),
      sentMessage({ body: new Uint8Array([0, 255, 13, 10]), delay: "5 seconds" }),
      sentMessage({
        retention: "60 seconds",
        experimentalConcurrencyKey: ConcurrencyKey.make("k"),
      }),
    ] as const;
    const sdkMessages = [
      { payload: Buffer.from(payload), idempotencyKey: "a", headers: { "X-B": "b" } },
      { payload: Buffer.from([0, 255, 13, 10]), delaySeconds: 5 },
      { payload: Buffer.from(payload), retentionSeconds: 60, experimental_concurrencyKey: "k" },
    ];

    const batchBoth = (response: TestHttpResponse) =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        return yield* compare(
          response,
          (server) =>
            sdkOutcome(
              () => sdkApi(server).sendBatch({ queueName: topic, messages: sdkMessages }),
              (results) => results.map((result) => ({ ...result })),
            ),
          ourOutcome(api.sendBatch(orders, messages), (results) => results.map(batchResultWire)),
        );
      });

    it.live("sends an identical multipart body and agrees on results", () =>
      Effect.gen(function* () {
        const result = yield* batchBoth({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            results: [
              { status: "sent", messageId: "m1" },
              { status: "deferred", messageId: null },
              { status: "failed", statusCode: 413, error: "too large", retryable: false },
            ],
          }),
        });
        assertSame(result);
        assert.strictEqual(
          result.sdkRequest?.headers["content-type"],
          "multipart/mixed; boundary=<boundary>",
        );
      }).pipe(run),
    );

    it.live("agrees on every error status and on a short result list", () =>
      Effect.gen(function* () {
        for (const [name, response] of errorStatuses) {
          const result = yield* batchBoth(response);
          assert.deepStrictEqual(result.ours, result.sdk, name);
          assert.deepStrictEqual(result.ourRequest, result.sdkRequest, name);
        }
        const short = yield* batchBoth({
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"results":[]}',
        });
        assert.deepStrictEqual(short.sdk, { error: "ServerError" });
        assert.deepStrictEqual(short.ours, { error: "Unexpected" });
      }).pipe(run),
    );
  });

  describe("receive", () => {
    const receiveBoth = (
      response: TestHttpResponse | (() => TestHttpResponse),
      options: {
        limit?: number;
        visibility?: number;
        cursorFallback?: "earliest" | "latest";
        region?: string;
      } = {},
    ) =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        return yield* compare(
          response,
          (server) =>
            sdkOutcome(
              async () => {
                const client = sdkApi(server);
                const regional =
                  options.region === undefined ? client : client.withRegion(options.region);
                const messages: Array<SdkMessage> = [];
                for await (const message of regional.receiveMessages({
                  queueName: topic,
                  consumerGroup: group,
                  limit: options.limit,
                  visibilityTimeoutSeconds: options.visibility,
                  cursorFallback: options.cursorFallback,
                })) {
                  messages.push(message);
                }
                return messages;
              },
              (messages) => messages.map(sdkMessageWire),
            ),
          ourOutcome(
            api.receive(orders, workers, {
              ...(options.limit === undefined ? {} : { limit: ReceiveLimit.make(options.limit) }),
              ...(options.visibility === undefined
                ? {}
                : { visibilityTimeout: `${options.visibility} seconds` as const }),
              ...(options.cursorFallback === undefined
                ? {}
                : { cursorFallback: options.cursorFallback }),
              ...(options.region === undefined
                ? {}
                : { region: VercelRegion.make(options.region) }),
            }),
            (messages) => messages.map(ourMessageWire),
          ),
        );
      });

    it.live("sends identical requests and parses multipart messages alike", () =>
      Effect.gen(function* () {
        const response = multipart(
          [
            part(queueHeaders("m1")),
            part({ "vqs-message-id": "skipped" }),
            part(queueHeaders("m2", { "vqs-delivery-count": "x" })),
            part(
              {
                "vqs-message-id": "m3",
                "vqs-receipt-handle": "rh_m3",
                "vqs-timestamp": "2026-03-01T10:00:00.000Z",
                "vqs-experimental-handoff-count": "2",
              },
              new Uint8Array([0, 13, 10, 45, 45, 1]),
            ),
          ],
          5,
        );
        const result = yield* receiveBoth(response, {
          limit: 3,
          visibility: 45,
          cursorFallback: "latest",
          region: "sfo1",
        });
        assertSame(result);
        assert.deepStrictEqual(
          "ok" in result.ours ? result.ours.ok.map((message) => message.messageId) : [],
          ["m1", "m3"],
        );
      }).pipe(run),
    );

    it.live("agrees on an empty queue", () =>
      Effect.gen(function* () {
        const result = yield* receiveBoth({ status: 204 });
        assertSame(result);
        assert.deepStrictEqual(result.ours, { ok: [] });
        assertSame(yield* receiveBoth(multipart([])));
      }).pipe(run),
    );

    it.live("agrees on every error status and on malformed bodies", () =>
      Effect.gen(function* () {
        for (const [name, response] of errorStatuses) {
          const result = yield* receiveBoth(response);
          assert.deepStrictEqual(result.ours, result.sdk, name);
          assert.deepStrictEqual(result.ourRequest, result.sdkRequest, name);
        }
        for (const response of [
          { status: 200, headers: { "content-type": "application/json" }, body: "{}" },
          {
            status: 200,
            headers: { "content-type": "multipart/mixed; boundary=x" },
            body: "--x\r\nvqs-message-id: a\r\n\r\ntruncated",
          },
        ]) {
          const result = yield* receiveBoth(response);
          assert.deepStrictEqual(result.ours, result.sdk);
        }
      }).pipe(run),
    );
  });

  describe("receiveById", () => {
    const receiveByIdBoth = (response: TestHttpResponse | (() => TestHttpResponse)) =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        return yield* compare(
          response,
          (server) =>
            sdkOutcome(
              () =>
                sdkApi(server).receiveMessageById({
                  queueName: topic,
                  consumerGroup: group,
                  messageId: "msg/1",
                  visibilityTimeoutSeconds: 60,
                }),
              ({ message }) => sdkMessageWire(message),
            ),
          ourOutcome(
            api.receiveById(orders, workers, MessageId.make("msg/1"), {
              visibilityTimeout: "60 seconds",
            }),
            ourMessageWire,
          ),
        );
      });

    it.live("sends identical requests and parses the message alike", () =>
      Effect.gen(function* () {
        assertSame(
          yield* receiveByIdBoth(
            multipart([part(queueHeaders("m1")), part(queueHeaders("m2"))], 3),
          ),
        );
      }).pipe(run),
    );

    it.live("agrees on missing and corrupt messages and every error status", () =>
      Effect.gen(function* () {
        const empty = yield* receiveByIdBoth(multipart([]));
        assertSame(empty);
        assert.deepStrictEqual(empty.ours, { error: "NotFound" });
        const corrupt = yield* receiveByIdBoth(multipart([part({ "vqs-message-id": "m1" })]));
        assertSame(corrupt);
        assert.deepStrictEqual(corrupt.ours, { error: "Corrupted" });
        for (const [name, response] of errorStatuses) {
          const result = yield* receiveByIdBoth(response);
          assert.deepStrictEqual(result.ours, result.sdk, name);
          assert.deepStrictEqual(result.ourRequest, result.sdkRequest, name);
        }
      }).pipe(run),
    );
  });

  describe("acknowledge", () => {
    const acknowledgeBoth = (response: TestHttpResponse, ifCoalesced?: number, region = "iad1") =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        return yield* compare(
          response,
          (server) =>
            sdkOutcome(
              () =>
                sdkApi(server).withRegion(region).acknowledgeMessage({
                  queueName: topic,
                  consumerGroup: group,
                  messageId: "msg_1",
                  receiptHandle: "rh/1",
                  experimental_ifCoalesced: ifCoalesced,
                }),
              () => "acknowledged",
            ),
          ourOutcome(
            api.acknowledge(
              handle(region),
              ifCoalesced === undefined ? {} : { experimentalIfCoalesced: ifCoalesced },
            ),
            () => "acknowledged",
          ),
        );
      });

    it.live("sends identical requests", () =>
      Effect.gen(function* () {
        assertSame(yield* acknowledgeBoth({ status: 204 }));
        assertSame(yield* acknowledgeBoth({ status: 200, body: "ok" }, 3, "sfo1"));
        assertSame(yield* acknowledgeBoth({ status: 204 }, 0));
      }).pipe(run),
    );

    it.live("agrees on every error status", () =>
      Effect.gen(function* () {
        for (const [name, response] of errorStatuses) {
          const result = yield* acknowledgeBoth(response);
          assert.deepStrictEqual(result.ours, result.sdk, name);
          assert.deepStrictEqual(result.ourRequest, result.sdkRequest, name);
        }
      }).pipe(run),
    );
  });

  describe("changeVisibility", () => {
    const changeBoth = (response: TestHttpResponse, handoff = false) =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        return yield* compare(
          response,
          (server) =>
            sdkOutcome(
              () =>
                sdkApi(server).changeVisibility({
                  queueName: topic,
                  consumerGroup: group,
                  messageId: "msg_1",
                  receiptHandle: "rh/1",
                  visibilityTimeoutSeconds: 90,
                  experimental_handoff: handoff,
                }),
              (value) => value.experimental_handoff ?? "none",
            ),
          ourOutcome(
            api.changeVisibility(handle(), "90 seconds", { experimentalHandoff: handoff }),
            Option.getOrElse(() => "none"),
          ),
        );
      });

    it.live("sends identical requests and agrees on handoff outcomes", () =>
      Effect.gen(function* () {
        assertSame(yield* changeBoth({ status: 204 }));
        for (const outcome of ["accepted", "not_immediate", "limit_reached", "other"]) {
          assertSame(
            yield* changeBoth(
              { status: 200, headers: { "vqs-experimental-handoff": outcome } },
              true,
            ),
          );
        }
      }).pipe(run),
    );

    it.live("agrees on every error status", () =>
      Effect.gen(function* () {
        for (const [name, response] of errorStatuses) {
          const result = yield* changeBoth(response);
          assert.deepStrictEqual(result.ours, result.sdk, name);
          assert.deepStrictEqual(result.ourRequest, result.sdkRequest, name);
        }
      }).pipe(run),
    );
  });
});
