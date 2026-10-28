import { Schema } from "effect";

/** The service rejected the credentials (HTTP 401). */
export class ApiUnauthorized extends Schema.TaggedError<ApiUnauthorized>()("ApiUnauthorized", {
  message: Schema.String,
}) {}

/** The credentials are valid but lack access to the resource (HTTP 403). */
export class ApiForbidden extends Schema.TaggedError<ApiForbidden>()("ApiForbidden", {
  message: Schema.String,
}) {}

/** The service rejected the request parameters (HTTP 400). */
export class ApiBadRequest extends Schema.TaggedError<ApiBadRequest>()("ApiBadRequest", {
  message: Schema.String,
}) {}

/** The request body exceeds the platform limit, 4.5 MB for most Vercel endpoints (HTTP 413). */
export class ApiPayloadTooLarge extends Schema.TaggedError<ApiPayloadTooLarge>()(
  "ApiPayloadTooLarge",
  {
    message: Schema.String,
  },
) {}

/** The service is throttling the caller (HTTP 429). */
export class ApiRateLimited extends Schema.TaggedError<ApiRateLimited>()("ApiRateLimited", {
  message: Schema.String,
  /** Delay requested by the `Retry-After` header, when the service sent one. */
  retryAfter: Schema.Option(Schema.Duration),
}) {}

/** The service failed while handling the request (HTTP 5xx). */
export class ApiServerError extends Schema.TaggedError<ApiServerError>()("ApiServerError", {
  message: Schema.String,
  status: Schema.Int,
}) {}

/** The request never produced a response: DNS, connection, TLS, or timeout failure. */
export class ApiNetworkFailure extends Schema.TaggedError<ApiNetworkFailure>()(
  "ApiNetworkFailure",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The response had a status or body this client does not understand. */
export class ApiUnexpectedResponse extends Schema.TaggedError<ApiUnexpectedResponse>()(
  "ApiUnexpectedResponse",
  {
    message: Schema.String,
    status: Schema.Int,
  },
) {}

/** Every reason a Vercel API call can fail regardless of which service it targets. */
export const VercelApiErrorReason = Schema.Union([
  ApiUnauthorized,
  ApiForbidden,
  ApiBadRequest,
  ApiPayloadTooLarge,
  ApiRateLimited,
  ApiServerError,
  ApiNetworkFailure,
  ApiUnexpectedResponse,
]);

/** Every reason a Vercel API call can fail regardless of which service it targets. */
export type VercelApiErrorReason = typeof VercelApiErrorReason.Type;

/**
 * A Vercel API call failed for a reason shared by all Vercel services.
 *
 * Service packages report their domain failures (a missing message, a missing blob) as their own
 * tagged errors and use this one for everything else. Handle individual reasons with
 * `Effect.catchReason("VercelApiError", "ApiRateLimited", ...)`.
 */
export class VercelApiError extends Schema.TaggedError<VercelApiError>()("VercelApiError", {
  /** Traced operation that failed, such as `QueueApi.send`. */
  operation: Schema.String,
  /** Machine-readable error code from the response (for example `Vqs-Error-Code`), if any. */
  errorCode: Schema.Option(Schema.String),
  reason: VercelApiErrorReason,
}) {}
