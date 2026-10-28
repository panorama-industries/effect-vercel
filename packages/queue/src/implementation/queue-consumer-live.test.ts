import { assert, describe, it } from "@effect/vitest";
import {
  ApiServerError,
  VercelApiError,
  VercelRegion,
} from "@panorama-industries/effect-vercel-core";
import { DateTime, Duration, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type { ConsumeOptions, MessageHandler } from "../contracts/message-handling.ts";
import type { MessageMetadata } from "../contracts/queue-domain.ts";

import { RetryDirective } from "../contracts/message-handling.ts";
import { QueueApi } from "../contracts/queue-api.ts";
import { QueueAuth, QueueConfig } from "../contracts/queue-config.ts";
import { QueueConsumer } from "../contracts/queue-consumer.ts";
import {
  ConsumerGroupName,
  MessageAlreadyProcessed,
  MessageNotFound,
  type MessageId,
} from "../contracts/queue-domain.ts";
import { Topic } from "../contracts/topic.ts";
import { TestQueue } from "../testing/test-queue.ts";
import { QueueConsumerLive } from "./queue-consumer-live.ts";

const Order = Schema.Struct({ id: Schema.String });
const Orders = Topic.json("orders", Order);
const group = ConsumerGroupName.make("fulfilment");
const iad1 = VercelRegion.make("iad1");
const lhr1 = VercelRegion.make("lhr1");

const ConfigTest = Layer.succeed(
  QueueConfig,
  QueueConfig.of({
    region: iad1,
    baseUrl: (region) => new URL(`https://${region}.vercel-queue.com`),
    auth: QueueAuth.Oidc(),
    deploymentId: Option.none(),
    pinSends: true,
    headers: {},
  }),
);

const TestLayer = QueueConsumerLive.pipe(
  Layer.provideMerge(TestQueue.layer),
  Layer.provide(ConfigTest),
);

const encode = (payload: typeof Order.Type) => Schema.encodeEffect(Orders.wire)(payload);

const publish = (payload: typeof Order.Type) =>
  Effect.gen(function* () {
    const api = yield* QueueApi;
    const result = yield* api.send(Orders.name, {
      body: yield* encode(payload),
      contentType: Orders.contentType,
    });
    assert.strictEqual(result._tag, "Sent");
    return (result as { readonly messageId: MessageId }).messageId;
  });

const structuredRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/queue", {
    method: "POST",
    headers: { "content-type": "application/cloudevents+json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const structuredEvent = (messageId: string) => ({
  type: "com.vercel.queue.v1beta",
  source: "/topic/orders/consumer/fulfilment",
  id: "evt_1",
  datacontenttype: "application/json",
  data: { queueName: "orders", consumerGroup: "fulfilment", messageId },
});

const binaryRequest = (headers: Record<string, string>, body?: Uint8Array) =>
  new Request("https://app.test/api/queue", {
    method: "POST",
    headers: {
      "ce-type": "com.vercel.queue.v2beta",
      "ce-vqsqueuename": "orders",
      "ce-vqsconsumergroup": "fulfilment",
      ...headers,
    },
    ...(body === undefined ? {} : { body: body.slice() }),
  });

const push = <E, R2 = never>(
  request: Request,
  handle: MessageHandler<typeof Order.Type, E, never>,
  options?: ConsumeOptions<E, R2>,
) =>
  Effect.gen(function* () {
    const consumer = yield* QueueConsumer;
    const response = yield* consumer
      .handler(Orders, handle, options)
      .pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );
    const web = HttpServerResponse.toWeb(response);
    const body: unknown = yield* Effect.promise(() => web.json());
    return { status: web.status, contentType: web.headers.get("content-type"), body };
  });

const ok = () => Effect.void;

/** Lease a message the way the queue does before an inline (binary, small body) push. */
const leaseInline = (visibilityTimeout: Duration.Input = Duration.minutes(5)) =>
  Effect.gen(function* () {
    const api = yield* QueueApi;
    const [message] = yield* api.receive(Orders.name, group, { visibilityTimeout });
    assert.isDefined(message);
    return message!;
  });

const operations = Effect.map(
  TestQueue.use((queue) => queue.calls),
  (calls) => calls.map((call) => call.operation),
);

const deliveryStatus = (messageId: MessageId) =>
  TestQueue.use((queue) => queue.delivery(Orders.name, group, messageId)).pipe(
    Effect.map(Option.map((state) => state.status)),
  );

describe("QueueConsumerLive", () => {
  describe("structured mode (v1beta)", () => {
    it.effect("leases the message by id, runs the handler and acknowledges", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        const seen = yield* Ref.make<Array<[string, MessageMetadata]>>([]);

        const response = yield* push(structuredRequest(structuredEvent(id)), (order, meta) =>
          Ref.update(seen, (all): Array<[string, MessageMetadata]> => [...all, [order.id, meta]]),
        );

        assert.deepStrictEqual(response, {
          status: 200,
          contentType: "application/json",
          body: { status: "success" },
        });
        const [[orderId, meta]] = (yield* Ref.get(seen)) as [[string, MessageMetadata]];
        assert.strictEqual(orderId, "ord_1");
        assert.strictEqual(meta.deliveryCount, 1);
        assert.strictEqual(meta.region, iad1);
        assert.deepStrictEqual(yield* operations, ["send", "receiveById", "acknowledge"]);

        const calls = yield* TestQueue.use((queue) => queue.calls);
        assert.deepStrictEqual(calls[1]?.visibilityTimeout, Duration.minutes(5));
        assert.strictEqual(calls[1]?.region, iad1);
        assert.deepStrictEqual(yield* deliveryStatus(id), Option.some("acknowledged"));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("clamps the visibility timeout to at least 30 seconds", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        yield* push(structuredRequest(structuredEvent(id)), ok, { visibilityTimeout: "5 seconds" });
        const calls = yield* TestQueue.use((queue) => queue.calls);
        assert.deepStrictEqual(calls[1]?.visibilityTimeout, Duration.seconds(30));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect.each([
      {
        name: "a body that is not JSON",
        request: structuredRequest("{not json"),
        error: "Failed to parse CloudEvent from request body",
      },
      {
        name: "a content type other than CloudEvents JSON",
        request: structuredRequest(structuredEvent("msg_1"), {
          "content-type": "application/json",
        }),
        error: "Invalid content type: expected 'application/cloudevents+json'",
      },
      {
        name: "missing envelope fields",
        request: structuredRequest({ type: "com.vercel.queue.v1beta", source: "/x", data: {} }),
        error: "Invalid CloudEvent: missing required fields",
      },
      {
        name: "a data field that is not an object",
        request: structuredRequest({ ...structuredEvent("msg_1"), data: "x" }),
        error: "Invalid CloudEvent: missing required fields",
      },
      {
        name: "another event type",
        request: structuredRequest({ ...structuredEvent("msg_1"), type: "com.example" }),
        error: "Invalid CloudEvent type: expected 'com.vercel.queue.v1beta', got 'com.example'",
      },
      {
        name: "missing data fields",
        request: structuredRequest({ ...structuredEvent("msg_1"), data: { queueName: "orders" } }),
        error: "Missing required CloudEvent data fields: consumerGroup, messageId",
      },
    ])("answers 400 for $name", ({ request, error }) =>
      Effect.gen(function* () {
        const response = yield* push(request, ok);
        assert.deepStrictEqual(response.status, 400);
        assert.deepStrictEqual(response.body, { error });
        assert.deepStrictEqual(yield* operations, []);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("answers 500 when the message does not exist (404)", () =>
      Effect.gen(function* () {
        const response = yield* push(structuredRequest(structuredEvent("msg_missing")), ok);
        assert.deepStrictEqual(response, {
          status: 500,
          contentType: "application/json",
          body: { error: "Failed to process queue message" },
        });
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("skips a message already processed (410)", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        yield* push(structuredRequest(structuredEvent(id)), ok);
        const response = yield* push(structuredRequest(structuredEvent(id)), ok);
        assert.deepStrictEqual(response, {
          status: 200,
          contentType: "application/json",
          body: { status: "skipped", reason: "already_processed", messageId: id },
        });
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("skips a message another consumer holds (409)", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        yield* leaseInline();
        const response = yield* push(structuredRequest(structuredEvent(id)), ok);
        assert.deepStrictEqual(response.body, {
          status: "skipped",
          reason: "not_available",
          messageId: id,
        });
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("binary mode (v2beta)", () => {
    it.effect("leases a large message by id in the region named by ce-vqsregion", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        const regions = yield* Ref.make<Array<string>>([]);
        const response = yield* push(
          binaryRequest({ "ce-vqsmessageid": id, "ce-vqsregion": "lhr1" }),
          (_, meta) => Ref.update(regions, (all) => [...all, meta.region]),
        );
        assert.deepStrictEqual(response.body, { status: "success" });
        assert.deepStrictEqual(yield* Ref.get(regions), [lhr1]);
        const calls = yield* TestQueue.use((queue) => queue.calls);
        assert.deepStrictEqual(
          calls.map((call) => [call.operation, call.region]),
          [
            ["send", iad1],
            ["receiveById", lhr1],
            ["acknowledge", lhr1],
          ],
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("processes an inline payload without fetching it", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        const leased = yield* leaseInline();
        const seen = yield* Ref.make<Option.Option<[string, MessageMetadata]>>(Option.none());

        const response = yield* push(
          binaryRequest(
            {
              "ce-vqsmessageid": id,
              "ce-vqsreceipthandle": leased.handle.receiptHandle,
              "ce-vqsdeliverycount": "3",
              "ce-vqscreatedat": "2026-01-01T00:00:00.000Z",
              "ce-vqsexperimentalhandoffcount": "2",
              "content-type": "application/json",
            },
            yield* encode({ id: "ord_1" }),
          ),
          (order, meta) => Ref.set(seen, Option.some([order.id, meta])),
        );

        assert.deepStrictEqual(response.body, { status: "success" });
        const [orderId, meta] = Option.getOrThrow(yield* Ref.get(seen));
        assert.strictEqual(orderId, "ord_1");
        assert.strictEqual(meta.deliveryCount, 3);
        assert.strictEqual(meta.experimentalHandoffCount, 2);
        assert.strictEqual(DateTime.formatIso(meta.createdAt), "2026-01-01T00:00:00.000Z");
        assert.strictEqual(DateTime.formatIso(meta.expiresAt), "2026-01-02T00:00:00.000Z");
        assert.deepStrictEqual(yield* operations, ["send", "receive", "acknowledge"]);
        assert.deepStrictEqual(yield* deliveryStatus(id), Option.some("acknowledged"));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("ignores a handoff count that is not a positive integer", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        const leased = yield* leaseInline();
        const counts = yield* Ref.make<Array<number | undefined>>([]);
        yield* push(
          binaryRequest(
            {
              "ce-vqsmessageid": id,
              "ce-vqsreceipthandle": leased.handle.receiptHandle,
              "ce-vqsexperimentalhandoffcount": "1.5",
            },
            yield* encode({ id: "ord_1" }),
          ),
          (_, meta) => Ref.update(counts, (all) => [...all, meta.experimentalHandoffCount]),
        );
        assert.deepStrictEqual(yield* Ref.get(counts), [undefined]);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect.each([
      {
        name: "missing routing headers",
        headers: { "ce-vqsqueuename": "", "ce-vqsconsumergroup": "" },
        error:
          "Missing required CloudEvent headers: ce-vqsqueuename, ce-vqsconsumergroup, ce-vqsmessageid",
      },
      {
        name: "an invalid region",
        headers: { "ce-vqsmessageid": "msg_1", "ce-vqsregion": "Iad-1" },
        error:
          'Invalid ce-vqsregion header: "Iad-1". Region must match /^[a-z]{2,5}[0-9]{1,2}$/ (e.g. "iad1", "lhr1").',
      },
      {
        name: "a receipt handle without a payload",
        headers: { "ce-vqsmessageid": "msg_1", "ce-vqsreceipthandle": "rh_1" },
        error: "Binary mode callback with receipt handle is missing payload",
      },
    ])("answers 400 for $name", ({ headers, error }) =>
      Effect.gen(function* () {
        const response = yield* push(binaryRequest(headers), ok);
        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(response.body, { error });
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("answers 500 when an inline acknowledgment finds no lease (404)", () =>
      Effect.gen(function* () {
        const response = yield* push(
          binaryRequest(
            { "ce-vqsmessageid": "msg_gone", "ce-vqsreceipthandle": "rh_gone" },
            yield* encode({ id: "ord_1" }),
          ),
          ok,
        );
        assert.strictEqual(response.status, 500);
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("failures and directives", () => {
    const pushOnce = <E>(
      handle: MessageHandler<typeof Order.Type, E, never>,
      options?: ConsumeOptions<E>,
    ) =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        const response = yield* push(structuredRequest(structuredEvent(id)), handle, options);
        return { id, response };
      });

    class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {}) {}
    const outOfStock = () => Effect.fail(new OutOfStock());

    it.effect("answers 500 and leaves the lease when the handler fails without a policy", () =>
      Effect.gen(function* () {
        const { id, response } = yield* pushOnce(outOfStock);
        assert.strictEqual(response.status, 500);
        assert.deepStrictEqual(yield* operations, ["send", "receiveById"]);
        assert.deepStrictEqual(yield* deliveryStatus(id), Option.some("leased"));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("answers 500 for a defect without consulting the policy", () =>
      Effect.gen(function* () {
        const consulted = yield* Ref.make(false);
        const { response } = yield* pushOnce(() => Effect.die("boom"), {
          onError: () => Ref.set(consulted, true).pipe(Effect.as(RetryDirective.Acknowledge())),
        });
        assert.strictEqual(response.status, 500);
        assert.isFalse(yield* Ref.get(consulted));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("reschedules with RetryAfter and answers success", () =>
      Effect.gen(function* () {
        const errors = yield* Ref.make<Array<unknown>>([]);
        const { id, response } = yield* pushOnce(outOfStock, {
          onError: (error) =>
            Ref.update(errors, (all) => [...all, error]).pipe(
              Effect.as(RetryDirective.RetryAfter({ delay: Duration.seconds(90) })),
            ),
        });
        assert.deepStrictEqual(response.body, { status: "success" });
        assert.deepStrictEqual(yield* Ref.get(errors), [new OutOfStock()]);
        const calls = yield* TestQueue.use((queue) => queue.calls);
        assert.strictEqual(calls[2]?.operation, "changeVisibility");
        assert.deepStrictEqual(calls[2]?.visibilityTimeout, Duration.seconds(90));
        assert.deepStrictEqual(yield* deliveryStatus(id), Option.some("leased"));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("hands the message off with ExperimentalHandoff", () =>
      Effect.gen(function* () {
        const { id } = yield* pushOnce(outOfStock, {
          onError: () => Effect.succeed(RetryDirective.ExperimentalHandoff()),
        });
        const calls = yield* TestQueue.use((queue) => queue.calls);
        assert.strictEqual(calls[2]?.experimentalHandoff, true);
        assert.deepStrictEqual(calls[2]?.visibilityTimeout, Duration.zero);
        const state = yield* TestQueue.use((queue) => queue.delivery(Orders.name, group, id));
        assert.strictEqual(Option.getOrThrow(state).handoffCount, 1);
        assert.strictEqual(Option.getOrThrow(state).status, "pending");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("acknowledges with Acknowledge", () =>
      Effect.gen(function* () {
        const { id, response } = yield* pushOnce(outOfStock, {
          onError: () => Effect.succeed(RetryDirective.Acknowledge()),
        });
        assert.deepStrictEqual(response.body, { status: "success" });
        assert.deepStrictEqual(yield* deliveryStatus(id), Option.some("acknowledged"));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("answers success even when applying the directive fails", () =>
      Effect.gen(function* () {
        const queue = yield* TestQueue;
        yield* queue.failNext(
          "changeVisibility",
          new VercelApiError({
            operation: "QueueApi.changeVisibility",
            errorCode: Option.none(),
            reason: new ApiServerError({ message: "unavailable", status: 503 }),
          }),
        );
        const { response } = yield* pushOnce(outOfStock, {
          onError: () => Effect.succeed(RetryDirective.RetryAfter({ delay: Duration.seconds(5) })),
        });
        assert.deepStrictEqual(response.body, { status: "success" });
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails the delivery when the policy itself dies", () =>
      Effect.gen(function* () {
        const { response } = yield* pushOnce(outOfStock, {
          onError: () => Effect.die("bad policy"),
        });
        assert.strictEqual(response.status, 500);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("passes an undecodable payload to the policy as PayloadDecodeFailed", () =>
      Effect.gen(function* () {
        const api = yield* QueueApi;
        const sent = yield* api.send(Orders.name, {
          body: new TextEncoder().encode('{"id":1}'),
          contentType: "application/json",
        });
        const id = (sent as { readonly messageId: MessageId }).messageId;
        const errors = yield* Ref.make<Array<string>>([]);
        const handled = yield* Ref.make(false);
        const response = yield* push(
          structuredRequest(structuredEvent(id)),
          () => Ref.set(handled, true),
          {
            onError: (error) =>
              Ref.update(errors, (all) => [...all, error._tag]).pipe(
                Effect.as(RetryDirective.Acknowledge()),
              ),
          },
        );
        assert.deepStrictEqual(response.body, { status: "success" });
        assert.deepStrictEqual(yield* Ref.get(errors), ["PayloadDecodeFailed"]);
        assert.isFalse(yield* Ref.get(handled));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("skips when the handler itself fails with MessageAlreadyProcessed", () =>
      Effect.gen(function* () {
        const { id, response } = yield* pushOnce(() =>
          Effect.fail(new MessageAlreadyProcessed({ messageId: "other" })),
        );
        assert.deepStrictEqual(response.body, {
          status: "skipped",
          reason: "already_processed",
          messageId: id,
        });
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("answers 500 when the acknowledgment fails", () =>
      Effect.gen(function* () {
        const queue = yield* TestQueue;
        yield* queue.failNext("acknowledge", new MessageNotFound({ messageId: "msg_1" }));
        const { response } = yield* pushOnce(ok);
        assert.strictEqual(response.status, 500);
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("coalesced reruns (experimental)", () => {
    it.effect("reruns the handler and acknowledges covering the coalesced count", () =>
      Effect.gen(function* () {
        const queue = yield* TestQueue;
        const id = yield* publish({ id: "ord_1" });
        const runs = yield* Ref.make<Array<MessageMetadata["experimentalCoalesced"]>>([]);
        const fiber = yield* push(
          structuredRequest(structuredEvent(id)),
          (_, meta) =>
            Effect.gen(function* () {
              const previous = yield* Ref.getAndUpdate(runs, (all) => [
                ...all,
                meta.experimentalCoalesced,
              ]);
              if (previous.length === 0) yield* queue.coalesce(Orders.name, group, id, 2);
              else yield* Effect.sleep("5 seconds");
            }),
          { experimentalMaxCoalescedReruns: 1 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        const response = yield* Fiber.join(fiber);

        assert.deepStrictEqual(response.body, { status: "success" });
        assert.deepStrictEqual(yield* Ref.get(runs), [undefined, { rerun: 1, coalescedCount: 2 }]);
        const calls = yield* queue.calls;
        assert.deepStrictEqual(
          calls
            .filter((call) => call.operation === "acknowledge")
            .map((call) => call.experimentalIfCoalesced),
          [undefined, 2],
        );
        // The rerun renews the lease at once, since how much of it is left is unknown.
        assert.deepStrictEqual(
          calls.filter((call) => call.operation === "changeVisibility").map((call) => call.at),
          [0],
        );
        assert.deepStrictEqual(yield* deliveryStatus(id), Option.some("acknowledged"));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("hands the refusal to the policy once the reruns are used up", () =>
      Effect.gen(function* () {
        const queue = yield* TestQueue;
        const id = yield* publish({ id: "ord_1" });
        yield* queue.coalesce(Orders.name, group, id, 1);
        const errors = yield* Ref.make<Array<unknown>>([]);
        const response = yield* push(structuredRequest(structuredEvent(id)), ok, {
          onError: (error) =>
            Ref.update(errors, (all) => [...all, error]).pipe(
              Effect.as(RetryDirective.Acknowledge()),
            ),
        });
        assert.deepStrictEqual(response.body, { status: "success" });
        const [error] = yield* Ref.get(errors);
        assert.deepStrictEqual(
          [(error as { _tag: string })._tag, (error as { coalescedCount: number }).coalescedCount],
          ["ConcurrencyCoalescedPending", 1],
        );
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("skips as not available when the policy answers Fail to a refusal", () =>
      Effect.gen(function* () {
        const queue = yield* TestQueue;
        const id = yield* publish({ id: "ord_1" });
        yield* queue.coalesce(Orders.name, group, id, 1);
        const response = yield* push(structuredRequest(structuredEvent(id)), ok);
        assert.deepStrictEqual(response.body, {
          status: "skipped",
          reason: "not_available",
          messageId: id,
        });
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("lease renewal", () => {
    const renewalTimes = TestQueue.use((queue) => queue.calls).pipe(
      Effect.map((calls) =>
        calls.filter((call) => call.operation === "changeVisibility").map((call) => call.at),
      ),
    );

    it.effect("times the first renewal from ce-vqsvisibilitydeadline", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        const leased = yield* leaseInline(Duration.seconds(50));
        const fiber = yield* push(
          binaryRequest(
            {
              "ce-vqsmessageid": id,
              "ce-vqsreceipthandle": leased.handle.receiptHandle,
              "ce-vqsvisibilitydeadline": new Date(50_000).toISOString(),
            },
            yield* encode({ id: "ord_1" }),
          ),
          () => Effect.sleep("75 seconds"),
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("75 seconds");
        yield* Fiber.join(fiber);
        // 50 s left: first renewal after max(10, 50/5) = 10 s, then every 60 s (5-minute lease).
        assert.deepStrictEqual(yield* renewalTimes, [10_000, 70_000]);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("renews at once when the visibility deadline has passed", () =>
      Effect.gen(function* () {
        const id = yield* publish({ id: "ord_1" });
        const leased = yield* leaseInline(Duration.seconds(50));
        yield* TestClock.adjust("1 second");
        const fiber = yield* push(
          binaryRequest(
            {
              "ce-vqsmessageid": id,
              "ce-vqsreceipthandle": leased.handle.receiptHandle,
              "ce-vqsvisibilitydeadline": new Date(500).toISOString(),
            },
            yield* encode({ id: "ord_1" }),
          ),
          () => Effect.sleep("5 seconds"),
          { visibilityTimeout: "100 seconds" },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(yield* renewalTimes, [1_000]);
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  it.effect("runs the handler in a consumer span linked to the producer's trace", () =>
    Effect.gen(function* () {
      const id = yield* publish({ id: "ord_1" });
      const spans = yield* Ref.make<
        Array<{ name: string; kind: string; links: Array<string>; system: unknown }>
      >([]);
      const traceId = "0af7651916cd43dd8448eb211c80319c";
      yield* push(
        structuredRequest(structuredEvent(id), {
          "x-vercel-queue-traceparent": `00-${traceId}-b7ad6b7169203331-01`,
        }),
        () =>
          Effect.flatMap(Effect.currentSpan, (span) =>
            Ref.set(spans, [
              {
                name: span.name,
                kind: span.kind,
                links: span.links.map((link) => link.span.traceId),
                system: span.attributes.get("messaging.system"),
              },
            ]),
          ).pipe(Effect.orDie),
      );
      const [span] = yield* Ref.get(spans);
      assert.deepStrictEqual(span, {
        name: "vqs.process",
        kind: "consumer",
        links: [traceId],
        system: "vercel-queue",
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});
