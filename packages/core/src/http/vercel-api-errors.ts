import type { HttpClientError, HttpClientResponse } from "effect/http";

import { Clock, Effect, Match, Option, Result, Schema } from "effect";
import { Headers } from "effect/http";

import {
  ApiBadRequest,
  ApiForbidden,
  ApiNetworkFailure,
  ApiPayloadTooLarge,
  ApiRateLimited,
  ApiServerError,
  ApiUnauthorized,
  ApiUnexpectedResponse,
  VercelApiError,
} from "../contracts/vercel-api-error.ts";

/** Identifies the failed call in a `VercelApiError`. */
export interface VercelApiErrorOptions {
  /** Traced operation name stored in `VercelApiError.operation`, such as `QueueApi.send`. */
  readonly operation: string;

  /** Response header carrying a machine-readable error code, such as `Vqs-Error-Code`. */
  readonly errorCodeHeader?: string | undefined;
}

const ErrorBody = Schema.Union([
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
  Schema.Struct({ message: Schema.String }),
]);

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

const messageFromBody = (body: ErrorBody): string =>
  "message" in body
    ? body.message
    : typeof body.error === "string"
      ? body.error
      : body.error.message;

type ErrorBody = typeof ErrorBody.Type;

/** Reads the most useful human-readable message from an error response body. */
export const responseErrorMessage = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const text = yield* Effect.orElseSucceed(response.text, () => "");
  const fallback = `HTTP ${response.status}`;
  const fromJson = Option.map(decodeErrorBody(text), messageFromBody);
  if (Option.isSome(fromJson)) {
    return fromJson.value;
  }
  const contentType = Option.getOrElse(Headers.get(response.headers, "content-type"), () => "");
  const trimmed = text.trim();
  return contentType.startsWith("text/") && trimmed.length > 0 ? trimmed : fallback;
});

const retryAfterOf = (response: HttpClientResponse.HttpClientResponse, now: number) =>
  Headers.get(response.headers, "retry-after").pipe(
    Option.flatMap((value) => Result.getSuccess(Headers.parseRetryAfter(value))),
    Option.map((retryAfter) => Headers.retryAfterDelay(retryAfter, now)),
  );

/**
 * Fail with the `VercelApiError` matching a non-2xx response.
 *
 * Maps 400, 401, 403, 413, 429 (with `Retry-After`) and 5xx to their `Api*` reasons and any other
 * status to `ApiUnexpectedResponse`. Handle domain statuses such as 404 before delegating here.
 * Consumes the response body to build the message.
 */
export const vercelApiErrorFromResponse = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  options: VercelApiErrorOptions,
): Effect.fn.Return<never, VercelApiError> {
  const message = yield* responseErrorMessage(response);
  const now = yield* Clock.currentTimeMillis;
  const status = response.status;
  const reason: VercelApiError["reason"] = Match.value(status).pipe(
    Match.when(400, () => new ApiBadRequest({ message })),
    Match.when(401, () => new ApiUnauthorized({ message })),
    Match.when(403, () => new ApiForbidden({ message })),
    Match.when(413, () => new ApiPayloadTooLarge({ message })),
    Match.when(429, () => new ApiRateLimited({ message, retryAfter: retryAfterOf(response, now) })),
    Match.when(
      (code) => code >= 500 && code <= 599,
      () => new ApiServerError({ message, status }),
    ),
    Match.orElse(() => new ApiUnexpectedResponse({ message, status })),
  );
  return yield* new VercelApiError({
    operation: options.operation,
    errorCode:
      options.errorCodeHeader === undefined
        ? Option.none()
        : Headers.get(response.headers, options.errorCodeHeader),
    reason,
  });
});

/**
 * Fail with the `VercelApiError` matching an `HttpClientError`.
 *
 * Transport failures become `ApiNetworkFailure`, status errors (from `HttpClient.filterStatusOk`)
 * are mapped like {@link vercelApiErrorFromResponse}, and unreadable bodies become
 * `ApiUnexpectedResponse`. Invalid URLs and body encoding failures are defects in the caller.
 */
export const vercelApiErrorFromHttpClientError = (
  error: HttpClientError.HttpClientError,
  options: VercelApiErrorOptions,
): Effect.Effect<never, VercelApiError> => {
  const fail = (reason: VercelApiError["reason"]) =>
    Effect.fail(
      new VercelApiError({ operation: options.operation, errorCode: Option.none(), reason }),
    );
  return Match.value(error.reason).pipe(
    Match.tagsExhaustive({
      TransportError: (reason) =>
        fail(new ApiNetworkFailure({ message: reason.message, cause: reason })),
      StatusCodeError: (reason) => vercelApiErrorFromResponse(reason.response, options),
      DecodeError: (reason) =>
        fail(
          new ApiUnexpectedResponse({ message: reason.message, status: reason.response.status }),
        ),
      EmptyBodyError: (reason) =>
        fail(
          new ApiUnexpectedResponse({ message: reason.message, status: reason.response.status }),
        ),
      EncodeError: () => Effect.die(error),
      InvalidUrlError: () => Effect.die(error),
    }),
  );
};
