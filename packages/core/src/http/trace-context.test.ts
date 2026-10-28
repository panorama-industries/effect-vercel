import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { spanLinkFromTraceparent, traceparentHeaders } from "./trace-context.ts";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "00f067aa0ba902b7";

describe("spanLinkFromTraceparent", () => {
  it("builds a link to the remote span", () => {
    const link = spanLinkFromTraceparent(`00-${traceId}-${spanId}-01`, {
      "messaging.system": "vercel",
    });
    assert.isTrue(Option.isSome(link));
    const value = Option.getOrThrow(link);
    assert.strictEqual(value.span.traceId, traceId);
    assert.strictEqual(value.span.spanId, spanId);
    assert.isTrue(value.span.sampled);
    assert.deepStrictEqual(value.attributes, { "messaging.system": "vercel" });
  });

  it("reads the sampled flag", () => {
    const link = spanLinkFromTraceparent(`00-${traceId}-${spanId}-00`);
    assert.isFalse(Option.getOrThrow(link).span.sampled);
  });

  it.each([
    "",
    "garbage",
    `01-${traceId}-${spanId}-01`,
    `00-${"0".repeat(32)}-${spanId}-01`,
    `00-${traceId}-01`,
  ])("rejects %j", (value) => {
    assert.isTrue(Option.isNone(spanLinkFromTraceparent(value)));
  });
});

describe("traceparentHeaders", () => {
  it.effect("is empty outside a span", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* traceparentHeaders(), {});
    }),
  );

  it.effect("encodes the current span under the requested header", () =>
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      const headers = yield* traceparentHeaders("x-vercel-queue-traceparent");
      assert.deepStrictEqual(headers, {
        "x-vercel-queue-traceparent": `00-${span.traceId}-${span.spanId}-01`,
      });
      const roundTrip = spanLinkFromTraceparent(headers["x-vercel-queue-traceparent"] ?? "");
      assert.strictEqual(Option.getOrThrow(roundTrip).span.spanId, span.spanId);
    }).pipe(Effect.withSpan("send")),
  );

  it.effect("defaults to the traceparent header", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(Object.keys(yield* traceparentHeaders()), ["traceparent"]);
    }).pipe(Effect.withSpan("send")),
  );
});
