import { Clock, Effect, Option, Pull, Schedule } from "effect";

import type { MessageMetadata } from "./contracts/queue-domain.ts";

import { RetryDirective } from "./contracts/message-handling.ts";

/**
 * Build an `onError` policy that redelivers failed messages on a `Schedule`.
 *
 * The n-th failed delivery (`deliveryCount` minus experimental handoffs, which do not count as
 * retries) waits for the schedule's n-th delay: the policy answers `RetryAfter(delay)` while the
 * schedule continues and `onExhausted` once it is done. The schedule receives the error as input
 * and is stepped from a fresh state on every call, all at the current time, so elapsed-time
 * schedules see no elapsed time.
 *
 * ```ts
 * consumer.handler(Orders, fulfil, {
 *   onError: retryOnSchedule(Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 5 }))),
 * });
 * ```
 *
 * @param schedule - Delay of each retry; its outputs are ignored.
 * @param options.onExhausted - Directive once the schedule is done. Default: `Acknowledge`, so the
 *   message is dropped.
 */
export const retryOnSchedule =
  <Out, In, R>(
    schedule: Schedule.Schedule<Out, In, never, R>,
    options?: { readonly onExhausted?: RetryDirective },
  ) =>
  (error: In, metadata: MessageMetadata): Effect.Effect<RetryDirective, never, R> =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(schedule);
      const now = yield* Clock.currentTimeMillis;
      const attempt = Math.max(
        1,
        metadata.deliveryCount - (metadata.experimentalHandoffCount ?? 0),
      );
      let delay = Option.none<RetryDirective>();
      for (let n = 0; n < attempt; n++) {
        delay = yield* step(now, error).pipe(
          Effect.map(([, duration]) => Option.some(RetryDirective.RetryAfter({ delay: duration }))),
          Pull.catchDone(() => Effect.succeed(Option.none<RetryDirective>())),
        );
        if (Option.isNone(delay)) break;
      }
      return Option.getOrElse(delay, () => options?.onExhausted ?? RetryDirective.Acknowledge());
    });
