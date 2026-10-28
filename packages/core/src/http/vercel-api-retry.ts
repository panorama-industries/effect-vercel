import { Duration, Effect, Option, Predicate, Schedule } from "effect";

import { VercelApiError } from "../contracts/vercel-api-error.ts";

/** Tuning for {@link vercelApiTransientRetry}. */
export interface VercelApiTransientRetryOptions {
  /** Total attempts including the first call. Defaults to 3. */
  readonly maxAttempts?: number | undefined;

  /** First backoff delay, doubled (with jitter) on each retry. Defaults to 100 milliseconds. */
  readonly baseDelay?: Duration.Input | undefined;
}

const retryAfterOf = (error: unknown): Option.Option<Duration.Duration> =>
  error instanceof VercelApiError && Predicate.isTagged(error.reason, "ApiRateLimited")
    ? error.reason.retryAfter
    : Option.none();

const isTransient = (error: unknown): boolean =>
  error instanceof VercelApiError &&
  (Predicate.isTagged(error.reason, "ApiNetworkFailure") ||
    Predicate.isTagged(error.reason, "ApiRateLimited"));

/**
 * Retry schedule for Vercel API calls that retries only transient failures:
 * `VercelApiError` with an `ApiNetworkFailure` or `ApiRateLimited` reason.
 *
 * Waits the `Retry-After` delay of a rate-limited response when the service sent one, otherwise
 * backs off exponentially with jitter. Use it with `Effect.retry(vercelApiTransientRetry())`.
 */
export const vercelApiTransientRetry = (
  options?: VercelApiTransientRetryOptions,
): Schedule.Schedule<Duration.Duration, unknown> => {
  const maxAttempts = options?.maxAttempts ?? 3;
  return Schedule.exponential(options?.baseDelay ?? "100 millis").pipe(
    Schedule.jittered,
    Schedule.setInputType<unknown>(),
    Schedule.while(({ input, attempt }) => attempt < maxAttempts && isTransient(input)),
    Schedule.modifyDelay(({ input, duration }) =>
      Effect.succeed(Option.getOrElse(retryAfterOf(input), () => duration)),
    ),
  );
};
