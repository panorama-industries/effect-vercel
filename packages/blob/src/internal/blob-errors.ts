import type { Headers, HttpClientResponse } from "effect/http";

import { VercelApiError, vercelApiErrorFromStatus } from "@panorama-industries/effect-vercel-core";
import { Clock, Effect, Option, Predicate, Schema } from "effect";

import {
  BlobClientTokenNotAllowed,
  BlobNotFound,
  BlobOidcEnvironmentNotAllowed,
  BlobPreconditionFailed,
  BlobStoreNotFound,
  BlobStoreSuspended,
  BlobStoreUnavailable,
  BlobUploadRejected,
  ClientTokenExpired,
  ContentTypeNotAllowed,
  FileTooLarge,
  PathnameMismatch,
} from "../contracts/blob-errors.ts";

/** Every Blob-specific failure an error response can map to. */
export type BlobDomainError =
  | BlobNotFound
  | BlobStoreUnavailable
  | BlobPreconditionFailed
  | BlobUploadRejected
  | BlobClientTokenNotAllowed
  | BlobOidcEnvironmentNotAllowed;

/** Tag of a {@link BlobDomainError}, used to choose which ones an operation reports. */
export type BlobDomainErrorTag = BlobDomainError["_tag"];

/** The domain errors among `K`, plus `VercelApiError` for every other error response. */
export type BlobApiError<K extends BlobDomainErrorTag = BlobDomainErrorTag> =
  | VercelApiError
  | Extract<BlobDomainError, { readonly _tag: K }>;

/** An error response (non-2xx) whose body has been read. */
export interface BlobErrorResponse {
  /** Traced operation name stored in `VercelApiError.operation`, such as `BlobStore.put`. */
  readonly operation: string;

  readonly status: number;

  /** The raw response body; JSON `{"error":{"code","message"}}` when the API produced it. */
  readonly body: string;

  /** Response headers; `Retry-After` is read from them for `rate_limited`. */
  readonly headers: Headers.Headers;

  /** The pathname or URL the call addressed, stored in `BlobNotFound.locator`. */
  readonly locator: string;
}

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optionalKey(
      Schema.Struct({
        code: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);

const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/** What the SDK's `getBlobError` reads from an error body, after its message-based rewrites. */
export interface BlobErrorCode {
  /** The effective code: `unknown_error` when the body had none or was not JSON. */
  readonly code: string;

  /** The code exactly as the body sent it, if it sent one. */
  readonly bodyCode: Option.Option<string>;

  readonly message: Option.Option<string>;
}

/**
 * Read the error code and message from an error body like the SDK's `getBlobError`, including the
 * rewrites it applies to codes older API clients cannot receive: a message about a disallowed
 * `contentType`, a `"pathname"` that does not match the token, `Token expired`, a file length
 * limit, or OIDC being disabled for an environment selects the matching code.
 */
export const blobErrorCode = (body: string): BlobErrorCode => {
  const error = Option.flatMap(decodeErrorBody(body), (decoded) =>
    Option.fromUndefinedOr(decoded.error),
  );
  const bodyCode = Option.flatMap(error, (error) => Option.fromUndefinedOr(error.code));
  const message = Option.flatMap(error, (error) => Option.fromUndefinedOr(error.message));
  let code = Option.getOrElse(bodyCode, () => "unknown_error");
  const text = Option.getOrUndefined(message);
  if (text !== undefined) {
    if (text.includes("contentType") && text.includes("is not allowed")) {
      code = "content_type_not_allowed";
    }
    if (text.includes('"pathname"') && text.includes("does not match the token payload")) {
      code = "client_token_pathname_mismatch";
    }
    if (text === "Token expired") {
      code = "client_token_expired";
    }
    if (text.includes("the file length cannot be greater than")) {
      code = "file_too_large";
    }
    if (
      text.startsWith("OIDC is enabled for this project, but not for the") &&
      text.includes("environment.")
    ) {
      code = "oidc_environment_not_allowed";
    }
  }
  return { code, bodyCode, message };
};

const unknownErrorMessage = "Unknown error, please visit https://vercel.com/help.";

/**
 * The message the store sends with `bad_request`, instead of a dedicated code, when a key does not
 * exist: the source of a copy or rename, or the blob an `ifMatch` write or delete targets.
 */
export const missingKeyMessage = "The specified key does not exist.";

const domainError = (
  code: string,
  message: Option.Option<string>,
  locator: string,
): Option.Option<BlobDomainError> => {
  const text = Option.getOrUndefined(message);
  switch (code) {
    case "not_found":
      return Option.some(new BlobNotFound({ locator }));
    case "store_not_found":
      return Option.some(new BlobStoreUnavailable({ reason: new BlobStoreNotFound() }));
    case "store_suspended":
      return Option.some(new BlobStoreUnavailable({ reason: new BlobStoreSuspended() }));
    case "precondition_failed":
      return Option.some(new BlobPreconditionFailed());
    case "content_type_not_allowed":
      return Option.some(
        new BlobUploadRejected({
          reason: new ContentTypeNotAllowed({ message: `Content type mismatch, ${text}.` }),
        }),
      );
    case "file_too_large":
      return Option.some(
        new BlobUploadRejected({
          reason: new FileTooLarge({ message: `File is too large, ${text}.` }),
        }),
      );
    case "client_token_pathname_mismatch":
      return Option.some(
        new BlobUploadRejected({
          reason: new PathnameMismatch({
            message:
              `Pathname mismatch, ${text}. Check the pathname used in upload() or put() ` +
              "matches the one from the client token.",
          }),
        }),
      );
    case "client_token_expired":
      return Option.some(new BlobUploadRejected({ reason: new ClientTokenExpired() }));
    case "client_token_not_allowed":
      return Option.some(
        new BlobClientTokenNotAllowed({
          message:
            text ??
            "This operation is not available when using a client token. Use a read–write or OIDC token on the server.",
        }),
      );
    case "oidc_environment_not_allowed":
      return Option.some(
        new BlobOidcEnvironmentNotAllowed({
          message:
            text ?? "OIDC is enabled for this project, but not for this token's environment.",
        }),
      );
    default:
      return Option.none();
  }
};

const rateLimitedMessage = (headers: Headers.Headers): string => {
  const seconds = Number.parseInt(headers["retry-after"] ?? "", 10);
  return `Too many requests please lower the number of concurrent requests${
    seconds ? ` - try again in ${seconds} seconds` : ""
  }.`;
};

/**
 * The status whose `Api*` reason the SDK's error matches, and that reason's message. Codes the SDK
 * maps regardless of status (`forbidden`, `bad_request`, `rate_limited`) force their status; the
 * rest keep the response's.
 */
const apiReasonFor = (
  code: string,
  response: BlobErrorResponse,
  message: Option.Option<string>,
): { readonly status: number; readonly message: string } => {
  const status = response.status;
  switch (code) {
    case "forbidden":
      return {
        status: 403,
        message: "Access denied, please provide a valid token for this resource.",
      };
    case "bad_request":
      return { status: 400, message: Option.getOrElse(message, () => "Bad request") };
    case "rate_limited":
      return {
        status: 429,
        message: rateLimitedMessage(response.headers),
      };
    case "service_unavailable":
      return {
        status,
        message: "The blob service is currently not available. Please try again.",
      };
    default:
      return { status, message: Option.getOrElse(message, () => unknownErrorMessage) };
  }
};

/**
 * Map an error response to the failure the SDK's `getBlobError` would throw, as a typed error.
 *
 * Domain codes become the errors in `contracts/blob-errors.ts`; `forbidden`, `bad_request` and
 * `rate_limited` become `VercelApiError` with `ApiForbidden`, `ApiBadRequest` and `ApiRateLimited`
 * (with `Retry-After`) whatever the status; every other code becomes the `VercelApiError` matching
 * the status (`vercelApiErrorFromStatus`). `VercelApiError.errorCode` is the code the body sent, if
 * any. A domain code not listed in `domainErrors` is reported as a `VercelApiError` for its status
 * instead, with that code, so an operation only surfaces the domain errors its contract declares.
 *
 * Unlike the SDK, a `bad_request` with {@link missingKeyMessage} becomes `BlobNotFound` for an
 * operation that reports it (a missing copy or rename source), and `BlobPreconditionFailed`
 * otherwise (`ifMatch` on a missing blob, which HTTP treats as a failed precondition).
 *
 * @param now - Current time in epoch milliseconds, to resolve an HTTP-date `Retry-After`.
 * @param domainErrors - Domain errors the operation reports; all of them by default.
 */
export const blobErrorFromResponse = <K extends BlobDomainErrorTag = BlobDomainErrorTag>(
  response: BlobErrorResponse,
  now: number,
  domainErrors?: ReadonlyArray<K>,
): BlobApiError<K> => {
  const { code, bodyCode, message } = blobErrorCode(response.body);
  const reports = (tag: BlobDomainErrorTag) =>
    domainErrors === undefined || (domainErrors as ReadonlyArray<string>).includes(tag);
  if (code === "bad_request" && Option.getOrUndefined(message) === missingKeyMessage) {
    if (reports("BlobNotFound")) {
      return new BlobNotFound({ locator: response.locator }) as BlobApiError<K>;
    }
    if (reports("BlobPreconditionFailed")) {
      return new BlobPreconditionFailed() as BlobApiError<K>;
    }
  }
  const domain = domainError(code, message, response.locator).pipe(
    Option.filter((error) => reports(error._tag)),
  );
  if (Option.isSome(domain)) {
    return domain.value as Extract<BlobDomainError, { readonly _tag: K }>;
  }
  const reason = apiReasonFor(code, response, message);
  return vercelApiErrorFromStatus(
    {
      operation: response.operation,
      status: reason.status,
      message: reason.message,
      errorCode: bodyCode,
      headers: response.headers,
    },
    now,
  );
};

/**
 * Read an error response's body and map it with {@link blobErrorFromResponse}. A body that cannot be
 * read counts as not JSON (`unknown_error`).
 */
export const blobErrorFromHttpResponse = Effect.fnUntraced(function* <
  K extends BlobDomainErrorTag = BlobDomainErrorTag,
>(
  response: HttpClientResponse.HttpClientResponse,
  options: {
    readonly operation: string;
    readonly locator: string;
    readonly domainErrors?: ReadonlyArray<K> | undefined;
  },
): Effect.fn.Return<never, BlobApiError<K>> {
  const body = yield* Effect.orElseSucceed(response.text, () => "");
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.fail(
    blobErrorFromResponse(
      {
        operation: options.operation,
        status: response.status,
        body,
        headers: response.headers,
        locator: options.locator,
      },
      now,
      options.domainErrors,
    ),
  );
});

const retryableCodes: ReadonlySet<string> = new Set([
  "unknown_error",
  "service_unavailable",
  "internal_server_error",
]);

/**
 * Whether the SDK retries a failed attempt: network failures, and error responses whose body code
 * is absent (a body that is not JSON counts as `unknown_error`), `unknown_error`,
 * `service_unavailable` or `internal_server_error`. Never `rate_limited`, a domain error, or any
 * other code. Use it as `vercelApiTransientRetry({ isRetryable })`.
 */
export const isRetryableBlobError = (error: unknown): boolean =>
  error instanceof VercelApiError &&
  (Predicate.isTagged(error.reason, "ApiNetworkFailure") ||
    Option.match(error.errorCode, {
      onNone: () => true,
      onSome: (code) => retryableCodes.has(code),
    }));
