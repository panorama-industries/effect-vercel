import type { DateTime, Scope } from "effect";

import { Clock, Duration, Effect, Option } from "effect";

import type { QueueApi } from "../contracts/queue-api.ts";
import type { MessageHandle } from "../contracts/queue-domain.ts";

const DEFAULT_VISIBILITY_TIMEOUT = Duration.minutes(5);
const MIN_VISIBILITY_TIMEOUT = Duration.seconds(30);
const MIN_RENEWAL_INTERVAL = Duration.seconds(10);
const MAX_RENEWAL_INTERVAL = Duration.seconds(60);
const RENEWAL_RETRY_INTERVAL = Duration.seconds(3);

export const leaseVisibilityTimeout = (input: Duration.Input | undefined): Duration.Duration =>
  Duration.max(
    MIN_VISIBILITY_TIMEOUT,
    input === undefined ? DEFAULT_VISIBILITY_TIMEOUT : Duration.fromInputUnsafe(input),
  );

export const renewalInterval = (timeout: Duration.Duration): Duration.Duration =>
  Duration.clamp(Duration.millis(Duration.toMillis(timeout) / 5), {
    minimum: MIN_RENEWAL_INTERVAL,
    maximum: MAX_RENEWAL_INTERVAL,
  });

export type LeaseDeadline = Option.Option<DateTime.Utc | "expired">;

const firstRenewalDelay = Effect.fnUntraced(function* (
  timeout: Duration.Duration,
  deadline: LeaseDeadline,
) {
  if (Option.isNone(deadline)) return renewalInterval(timeout);
  if (deadline.value === "expired") return Duration.zero;
  const now = yield* Clock.currentTimeMillis;
  const remaining = deadline.value.epochMilliseconds - now;
  return remaining > 0 ? renewalInterval(Duration.millis(remaining)) : Duration.zero;
});

/**
 * Keeps a lease alive until the enclosing scope closes. Transient failures retry every 3 seconds;
 * a lost or rejected lease (400, 401, 403, 404, 409) ends renewal.
 */
export const keepLeaseAlive = Effect.fnUntraced(
  function* (
    api: QueueApi["Service"],
    handle: MessageHandle,
    timeout: Duration.Duration,
    deadline: LeaseDeadline,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    const interval = renewalInterval(timeout);
    const stop = (error: unknown) =>
      Effect.logError("Lease renewal failed with a client error; stopping renewal", error).pipe(
        Effect.as(Option.none<Duration.Duration>()),
      );

    const renew = api.changeVisibility(handle, timeout).pipe(
      Effect.as(Option.some(interval)),
      Effect.catchTags({ MessageNotFound: stop, MessageNotAvailable: stop }),
      Effect.catchReasons("VercelApiError", {
        ApiBadRequest: (_, error) => stop(error),
        ApiUnauthorized: (_, error) => stop(error),
        ApiForbidden: (_, error) => stop(error),
      }),
      Effect.catch((error) =>
        Effect.logError("Lease renewal failed; retrying in 3 seconds", error).pipe(
          Effect.as(Option.some(RENEWAL_RETRY_INTERVAL)),
        ),
      ),
    );

    const loop = Effect.fnUntraced(function* (initialDelay: Duration.Duration) {
      let delay: Option.Option<Duration.Duration> = Option.some(initialDelay);
      while (Option.isSome(delay)) {
        yield* Effect.sleep(delay.value);
        delay = yield* renew;
      }
    });

    yield* Effect.forkScoped(loop(yield* firstRenewalDelay(timeout, deadline)), {
      startImmediately: true,
    });
  },
  Effect.annotateLogs({ module: "QueueLease" }),
);
