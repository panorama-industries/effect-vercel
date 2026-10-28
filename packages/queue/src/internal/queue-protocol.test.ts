import { assert, describe, it } from "@effect/vitest";
import { Duration, Option } from "effect";

import {
  apiBaseUrl,
  coalescedPendingCount,
  errorBodyOf,
  messageHeaders,
  queuePartHeaders,
  retryAfterFromHeader,
  topicPath,
  wholeSeconds,
} from "./queue-protocol.ts";

describe("queue protocol", () => {
  it("builds URLs like the SDK", () => {
    assert.strictEqual(
      apiBaseUrl(new URL("https://iad1.vercel-queue.com")),
      "https://iad1.vercel-queue.com/api/v3/topic",
    );
    assert.strictEqual(
      apiBaseUrl(new URL("http://localhost:4100/base//?q=1")),
      "http://localhost:4100/base/api/v3/topic",
    );
    assert.strictEqual(
      topicPath("t", "consumer", "g", "lease", "a/b c"),
      "/t/consumer/g/lease/a%2Fb%20c",
    );
  });

  it("rounds durations up to whole seconds", () => {
    assert.strictEqual(wholeSeconds(Duration.zero), 0);
    assert.strictEqual(wholeSeconds("1 millis"), 1);
    assert.strictEqual(wholeSeconds("2 seconds"), 2);
    assert.strictEqual(wholeSeconds("2001 millis"), 3);
  });

  it("filters reserved message headers", () => {
    const headers = messageHeaders(
      { Authorization: "x", "X-Config": " c ", "Vqs-Delay-Seconds": "1" },
      {
        body: new Uint8Array(),
        contentType: "text/plain",
        headers: {
          "x-config": "m",
          "VQS-Anything": "no",
          "content-type": "no",
          authorization: "no",
        },
      },
    );
    assert.deepStrictEqual(headers.sorted(), [
      ["content-type", "text/plain"],
      ["vqs-delay-seconds", "1"],
      ["x-config", "m"],
    ]);
  });

  it("parses Retry-After as the SDK does", () => {
    const millis = (value: string | undefined, now = 0) =>
      Option.map(retryAfterFromHeader(value, now), Duration.toMillis);
    assert.deepStrictEqual(millis(undefined), Option.none());
    assert.deepStrictEqual(millis(""), Option.none());
    assert.deepStrictEqual(millis("0"), Option.some(0));
    assert.deepStrictEqual(millis("2.5"), Option.some(2500));
    assert.deepStrictEqual(millis("Thu, 01 Jan 1970 00:00:10 GMT", 4000), Option.some(6000));
    assert.deepStrictEqual(millis("soon"), Option.none());
  });

  it("reads error messages from JSON bodies only", () => {
    assert.strictEqual(errorBodyOf('{"error":"x"}', "text/plain").message, '{"error":"x"}');
    assert.strictEqual(errorBodyOf('{"error":"x"}', "application/json").message, "x");
    assert.strictEqual(
      errorBodyOf('{"error":{"message":"y"}}', "application/problem+json").message,
      "y",
    );
    assert.strictEqual(errorBodyOf('{"error":1}', "application/json").message, '{"error":1}');
    assert.strictEqual(errorBodyOf("nope", "application/json").message, "nope");
    assert.deepStrictEqual(
      errorBodyOf('{"originalMessageId":"m"}', "application/json").originalMessageId,
      Option.some("m"),
    );
  });

  it("reads the coalesced count from the header, then the body", () => {
    const code = "concurrency_coalesced_pending";
    assert.deepStrictEqual(coalescedPendingCount(code, "2", ""), Option.some(2));
    assert.deepStrictEqual(
      coalescedPendingCount(code, "0", '{"coalescedCount":3}'),
      Option.some(3),
    );
    assert.deepStrictEqual(
      coalescedPendingCount(code, undefined, '{"coalescedCount":1.5}'),
      Option.none(),
    );
    assert.deepStrictEqual(coalescedPendingCount("other", "2", ""), Option.none());
  });

  it("requires message id, timestamp, receipt handle and a numeric delivery count", () => {
    const base = { "vqs-message-id": "m", "vqs-timestamp": "t", "vqs-receipt-handle": "r" };
    assert.isTrue(Option.isSome(queuePartHeaders(base)));
    assert.isTrue(Option.isNone(queuePartHeaders({ ...base, "vqs-message-id": "" })));
    assert.isTrue(Option.isNone(queuePartHeaders({ ...base, "vqs-delivery-count": "x" })));
    assert.deepStrictEqual(
      Option.map(
        queuePartHeaders({ ...base, "vqs-delivery-count": "4abc" }),
        (h) => h.deliveryCount,
      ),
      Option.some(4),
    );
    assert.deepStrictEqual(
      Option.map(
        queuePartHeaders({ ...base, "vqs-experimental-handoff-count": "0" }),
        (h) => h.handoffCount,
      ),
      Option.some(Option.none()),
    );
  });
});
