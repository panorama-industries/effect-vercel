import type { Redacted } from "effect";

import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

/** How {@link withVercelApi} addresses and authenticates every request. */
export interface VercelApiClientOptions<E, R> {
  /** Prepended to every request URL, e.g. `https://iad1.vercel-queue.com/api/v3`. */
  readonly baseUrl: string;

  /** Bearer token, evaluated for every request so rotated or refreshed tokens are picked up. */
  readonly token: Effect.Effect<Redacted.Redacted<string>, E, R>;

  /** `User-Agent` value, conventionally `<package name>/<version>`. */
  readonly userAgent: string;

  /** Extra headers set on every request; they override the defaults above. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * Configure an `HttpClient` to call a Vercel API: prepend the base URL, set `Authorization: Bearer`
 * from `options.token` on every request, and set `User-Agent` plus any extra headers.
 *
 * Status codes are left untouched; map failures with `vercelApiErrorFromResponse` and
 * `vercelApiErrorFromHttpClientError`.
 *
 * @returns A client whose requests may also fail with the token's error `E`.
 */
export const withVercelApi =
  <E2, R2>(options: VercelApiClientOptions<E2, R2>) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>): HttpClient.HttpClient.With<E | E2, R | R2> =>
    HttpClient.mapRequestEffect(client, (request) =>
      Effect.map(options.token, (token) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.baseUrl),
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("User-Agent", options.userAgent),
          HttpClientRequest.setHeaders(options.headers ?? {}),
        ),
      ),
    );
