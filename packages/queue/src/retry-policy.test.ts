import { assert, describe, it } from "@effect/vitest";
import { VercelRegion } from "@panorama-industries/effect-vercel-core";
import { DateTime, Duration, Effect, Schedule } from "effect";

import { RetryDirective } from "./contracts/message-handling.ts";
import {
  ConsumerGroupName,
  MessageId,
  MessageMetadata,
  TopicName,
} from "./contracts/queue-domain.ts";
import { retryOnSchedule } from "./retry-policy.ts";

const metadata = (deliveryCount: number, experimentalHandoffCount?: number) =>
  new MessageMetadata({
    messageId: MessageId.make("msg_1"),
    deliveryCount,
    createdAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(86_400_000),
    topic: TopicName.make("orders"),
    consumerGroup: ConsumerGroupName.make("fulfilment"),
    region: VercelRegion.make("iad1"),
    ...(experimentalHandoffCount === undefined ? {} : { experimentalHandoffCount }),
  });

const policy = retryOnSchedule(Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 3 })));

describe("retryOnSchedule", () => {
  it.effect("delays each redelivery by the schedule's step for that delivery", () =>
    Effect.gen(function* () {
      const directives = yield* Effect.forEach([1, 2, 3], (count) =>
        policy("error", metadata(count)),
      );
      assert.deepStrictEqual(directives, [
        RetryDirective.RetryAfter({ delay: Duration.seconds(1) }),
        RetryDirective.RetryAfter({ delay: Duration.seconds(2) }),
        RetryDirective.RetryAfter({ delay: Duration.seconds(4) }),
      ]);
    }),
  );

  it.effect("acknowledges once the schedule is exhausted", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* policy("error", metadata(4)), RetryDirective.Acknowledge());
    }),
  );

  it.effect("answers the configured directive once exhausted", () =>
    Effect.gen(function* () {
      const failing = retryOnSchedule(Schedule.recurs(0), { onExhausted: RetryDirective.Fail() });
      assert.deepStrictEqual(yield* failing("error", metadata(1)), RetryDirective.Fail());
    }),
  );

  it.effect("does not count handoffs as retries", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* policy("error", metadata(4, 2)),
        RetryDirective.RetryAfter({ delay: Duration.seconds(2) }),
      );
    }),
  );

  it.effect("feeds the error to the schedule", () =>
    Effect.gen(function* () {
      const byError = retryOnSchedule(
        Schedule.spaced("1 second").pipe(
          Schedule.setInputType<string>(),
          Schedule.modifyDelay(({ input, duration }) =>
            Effect.succeed(input === "slow" ? Duration.minutes(1) : duration),
          ),
        ),
      );
      assert.deepStrictEqual(
        yield* byError("slow", metadata(1)),
        RetryDirective.RetryAfter({ delay: Duration.minutes(1) }),
      );
    }),
  );
});
