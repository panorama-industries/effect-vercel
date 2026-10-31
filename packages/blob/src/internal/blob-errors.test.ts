import { assert, describe, it } from "@effect/vitest";
import {
  ApiBadRequest,
  ApiForbidden,
  ApiNetworkFailure,
  ApiRateLimited,
  ApiServerError,
  ApiUnauthorized,
  ApiUnexpectedResponse,
  VercelApiError,
} from "@panorama-industries/effect-vercel-core";
import { Duration, Option } from "effect";
import { Headers } from "effect/http";

import type { BlobDomainErrorTag } from "./blob-errors.ts";

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
import { blobErrorCode, blobErrorFromResponse, isRetryableBlobError } from "./blob-errors.ts";

const body = (code?: string, message?: string) =>
  JSON.stringify({
    error: {
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
    },
  });

const map = (
  status: number,
  text: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly domainErrors?: ReadonlyArray<BlobDomainErrorTag>;
  } = {},
) =>
  blobErrorFromResponse(
    {
      operation: "BlobStore.test",
      status,
      body: text,
      headers: Headers.fromInput(options.headers ?? {}),
      locator: "folder/file.txt",
    },
    0,
    options.domainErrors,
  );

const apiError = (error: unknown) => {
  assert.instanceOf(error, VercelApiError);
  return error as VercelApiError;
};

const uploadRejection = (error: unknown) => {
  assert.instanceOf(error, BlobUploadRejected);
  return (error as BlobUploadRejected).reason;
};

describe("blobErrorCode", () => {
  it("reads the code and message of a JSON error body", () => {
    const parsed = blobErrorCode(body("store_suspended", "suspended"));
    assert.strictEqual(parsed.code, "store_suspended");
    assert.deepStrictEqual(parsed.bodyCode, Option.some("store_suspended"));
    assert.deepStrictEqual(parsed.message, Option.some("suspended"));
  });

  it("treats a body that is not JSON as unknown_error without a body code", () => {
    for (const text of ["", "<html>Bad gateway</html>", "null", '"text"', '{"error":"x"}']) {
      const parsed = blobErrorCode(text);
      assert.strictEqual(parsed.code, "unknown_error");
      assert.isTrue(Option.isNone(parsed.bodyCode));
    }
  });

  it("treats an error without a code as unknown_error but keeps its message", () => {
    const parsed = blobErrorCode(body(undefined, "something"));
    assert.strictEqual(parsed.code, "unknown_error");
    assert.isTrue(Option.isNone(parsed.bodyCode));
    assert.deepStrictEqual(parsed.message, Option.some("something"));
  });

  it.each([
    ['"contentType" text/plain is not allowed', "content_type_not_allowed"],
    [
      'Invalid "pathname": "a.txt" does not match the token payload "b.txt"',
      "client_token_pathname_mismatch",
    ],
    ["Token expired", "client_token_expired"],
    ["Invalid file: the file length cannot be greater than 100 bytes", "file_too_large"],
    [
      "OIDC is enabled for this project, but not for the preview environment.",
      "oidc_environment_not_allowed",
    ],
  ])("rewrites the code for the message %j", (message, code) => {
    const parsed = blobErrorCode(body("forbidden", message));
    assert.strictEqual(parsed.code, code);
    assert.deepStrictEqual(parsed.bodyCode, Option.some("forbidden"));
  });

  it("does not rewrite near misses", () => {
    assert.strictEqual(
      blobErrorCode(body("bad_request", "Token expired soon")).code,
      "bad_request",
    );
    assert.strictEqual(
      blobErrorCode(body("bad_request", "contentType is required")).code,
      "bad_request",
    );
    assert.strictEqual(
      blobErrorCode(body("bad_request", "OIDC is enabled for this project, but not for the env"))
        .code,
      "bad_request",
    );
  });
});

describe("blobErrorFromResponse", () => {
  it("maps not_found to BlobNotFound with the caller's locator", () => {
    const error = map(500, body("not_found"));
    assert.instanceOf(error, BlobNotFound);
    assert.strictEqual((error as BlobNotFound).locator, "folder/file.txt");
  });

  it("maps store_not_found and store_suspended to BlobStoreUnavailable", () => {
    const notFound = map(700, body("store_not_found"));
    assert.instanceOf(notFound, BlobStoreUnavailable);
    assert.instanceOf((notFound as BlobStoreUnavailable).reason, BlobStoreNotFound);
    const suspended = map(300, body("store_suspended"));
    assert.instanceOf(suspended, BlobStoreUnavailable);
    assert.instanceOf((suspended as BlobStoreUnavailable).reason, BlobStoreSuspended);
  });

  it("maps precondition_failed to BlobPreconditionFailed", () => {
    assert.instanceOf(map(412, body("precondition_failed")), BlobPreconditionFailed);
  });

  it("maps upload constraint codes to BlobUploadRejected with the SDK's messages", () => {
    const contentType = uploadRejection(
      map(400, body("forbidden", '"contentType" text/plain is not allowed')),
    );
    assert.instanceOf(contentType, ContentTypeNotAllowed);
    assert.strictEqual(
      (contentType as ContentTypeNotAllowed).message,
      'Content type mismatch, "contentType" text/plain is not allowed.',
    );

    const tooLarge = uploadRejection(
      map(400, body("bad_request", "the file length cannot be greater than 10 bytes")),
    );
    assert.instanceOf(tooLarge, FileTooLarge);
    assert.strictEqual(
      (tooLarge as FileTooLarge).message,
      "File is too large, the file length cannot be greater than 10 bytes.",
    );

    const mismatch = uploadRejection(
      map(400, body("bad_request", '"pathname" does not match the token payload')),
    );
    assert.instanceOf(mismatch, PathnameMismatch);
    assert.include((mismatch as PathnameMismatch).message, "Pathname mismatch, ");

    assert.instanceOf(
      uploadRejection(map(400, body("bad_request", "Token expired"))),
      ClientTokenExpired,
    );
    assert.instanceOf(uploadRejection(map(400, body("client_token_expired"))), ClientTokenExpired);
    assert.instanceOf(uploadRejection(map(400, body("file_too_large", "x"))), FileTooLarge);
    assert.instanceOf(
      uploadRejection(map(400, body("content_type_not_allowed", "x"))),
      ContentTypeNotAllowed,
    );
    assert.instanceOf(
      uploadRejection(map(400, body("client_token_pathname_mismatch", "x"))),
      PathnameMismatch,
    );
  });

  it("maps client_token_not_allowed with the body message or the SDK default", () => {
    const withMessage = map(403, body("client_token_not_allowed", "Use a server token"));
    assert.instanceOf(withMessage, BlobClientTokenNotAllowed);
    assert.strictEqual((withMessage as BlobClientTokenNotAllowed).message, "Use a server token");
    const withoutMessage = map(403, body("client_token_not_allowed"));
    assert.include(
      (withoutMessage as BlobClientTokenNotAllowed).message,
      "not available when using a client token",
    );
  });

  it("maps oidc_environment_not_allowed, also when only the message says so", () => {
    const message = "OIDC is enabled for this project, but not for the preview environment.";
    const rewritten = map(403, body("forbidden", message));
    assert.instanceOf(rewritten, BlobOidcEnvironmentNotAllowed);
    assert.strictEqual((rewritten as BlobOidcEnvironmentNotAllowed).message, message);
    const coded = map(403, body("oidc_environment_not_allowed"));
    assert.instanceOf(coded, BlobOidcEnvironmentNotAllowed);
    assert.strictEqual(
      (coded as BlobOidcEnvironmentNotAllowed).message,
      "OIDC is enabled for this project, but not for this token's environment.",
    );
  });

  it("maps forbidden to ApiForbidden whatever the status", () => {
    const error = apiError(map(400, body("forbidden")));
    assert.instanceOf(error.reason, ApiForbidden);
    assert.deepStrictEqual(error.errorCode, Option.some("forbidden"));
    assert.strictEqual(error.operation, "BlobStore.test");
  });

  it("maps bad_request to ApiBadRequest with the body message", () => {
    const error = apiError(map(600, body("bad_request", "limit must be a number")));
    assert.instanceOf(error.reason, ApiBadRequest);
    assert.strictEqual(error.reason.message, "limit must be a number");
    assert.strictEqual(apiError(map(400, body("bad_request"))).reason.message, "Bad request");
  });

  it("maps rate_limited to ApiRateLimited with Retry-After", () => {
    const error = apiError(map(429, body("rate_limited"), { headers: { "retry-after": "5" } }));
    assert.instanceOf(error.reason, ApiRateLimited);
    const reason = error.reason as ApiRateLimited;
    assert.deepStrictEqual(reason.retryAfter, Option.some(Duration.seconds(5)));
    assert.include(reason.message, "try again in 5 seconds");
    const without = apiError(map(400, body("rate_limited"))).reason as ApiRateLimited;
    assert.instanceOf(without, ApiRateLimited);
    assert.isTrue(Option.isNone(without.retryAfter));
  });

  it("maps other codes from the status, keeping the body code", () => {
    const unavailable = apiError(map(503, body("service_unavailable")));
    assert.instanceOf(unavailable.reason, ApiServerError);
    assert.strictEqual(
      unavailable.reason.message,
      "The blob service is currently not available. Please try again.",
    );
    assert.deepStrictEqual(unavailable.errorCode, Option.some("service_unavailable"));

    const notAllowed = apiError(map(800, body("not_allowed")));
    assert.instanceOf(notAllowed.reason, ApiUnexpectedResponse);
    assert.strictEqual((notAllowed.reason as ApiUnexpectedResponse).status, 800);
    assert.deepStrictEqual(notAllowed.errorCode, Option.some("not_allowed"));

    const unauthorized = apiError(map(401, body("some_new_code", "Nope")));
    assert.instanceOf(unauthorized.reason, ApiUnauthorized);
    assert.strictEqual(unauthorized.reason.message, "Nope");
  });

  it("maps a body that is not JSON from the status, without an error code", () => {
    const error = apiError(map(502, "<html>Bad gateway</html>"));
    assert.instanceOf(error.reason, ApiServerError);
    assert.strictEqual(
      error.reason.message,
      "Unknown error, please visit https://vercel.com/help.",
    );
    assert.isTrue(Option.isNone(error.errorCode));
  });

  it("reports domain codes the operation does not declare as VercelApiError", () => {
    const error = apiError(map(404, body("not_found"), { domainErrors: ["BlobStoreUnavailable"] }));
    assert.instanceOf(error.reason, ApiUnexpectedResponse);
    assert.deepStrictEqual(error.errorCode, Option.some("not_found"));
    assert.instanceOf(
      map(403, body("store_suspended"), { domainErrors: ["BlobStoreUnavailable"] }),
      BlobStoreUnavailable,
    );
  });
});

describe("isRetryableBlobError", () => {
  const withCode = (code: Option.Option<string>, reason: VercelApiError["reason"]) =>
    new VercelApiError({ operation: "BlobStore.test", errorCode: code, reason });
  const server = new ApiServerError({ message: "x", status: 500 });

  it("retries network failures and unknown, unavailable and internal errors", () => {
    assert.isTrue(
      isRetryableBlobError(
        withCode(Option.none(), new ApiNetworkFailure({ message: "reset", cause: null })),
      ),
    );
    assert.isTrue(isRetryableBlobError(withCode(Option.none(), server)));
    assert.isTrue(isRetryableBlobError(withCode(Option.some("unknown_error"), server)));
    assert.isTrue(isRetryableBlobError(withCode(Option.some("service_unavailable"), server)));
    assert.isTrue(isRetryableBlobError(withCode(Option.some("internal_server_error"), server)));
  });

  it("does not retry rate limits, other codes or domain errors", () => {
    assert.isFalse(
      isRetryableBlobError(
        withCode(
          Option.some("rate_limited"),
          new ApiRateLimited({ message: "x", retryAfter: Option.none() }),
        ),
      ),
    );
    assert.isFalse(isRetryableBlobError(withCode(Option.some("forbidden"), server)));
    assert.isFalse(isRetryableBlobError(withCode(Option.some("not_allowed"), server)));
    assert.isFalse(
      isRetryableBlobError(new BlobStoreUnavailable({ reason: new BlobStoreSuspended() })),
    );
    assert.isFalse(isRetryableBlobError(new Error("boom")));
  });
});
