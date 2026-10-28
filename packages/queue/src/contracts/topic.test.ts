import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { Topic } from "./topic.ts";

class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  quantity: Schema.Int,
}) {}

describe("Topic", () => {
  it.effect("json topics round-trip payloads through UTF-8 JSON bytes", () =>
    Effect.gen(function* () {
      const orders = Topic.json("orders", Order);
      const order = new Order({ id: "ord_ñ", quantity: 2 });

      const bytes = yield* Schema.encodeEffect(orders.wire)(order);
      assert.strictEqual(new TextDecoder().decode(bytes), '{"id":"ord_ñ","quantity":2}');

      const decoded = yield* Schema.decodeEffect(orders.wire)(bytes);
      assert.deepStrictEqual(decoded, order);
    }),
  );

  it.effect("json topics reject bodies that do not match the schema", () =>
    Effect.gen(function* () {
      const orders = Topic.json("orders", Order);
      const result = yield* Schema.decodeEffect(orders.wire)(
        new TextEncoder().encode('{"id":1}'),
      ).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it("rejects invalid topic names where the topic is defined", () => {
    assert.throws(() => Topic.bytes("not a topic"));
  });
});
