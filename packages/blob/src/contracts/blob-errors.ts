import { Schema } from "effect";

/** The blob does not exist (`not_found`). */
export class BlobNotFound extends Schema.TaggedError<BlobNotFound>()("BlobNotFound", {
  /** The pathname or URL that was requested. */
  locator: Schema.String,
}) {}

/** The store addressed by the credentials does not exist (`store_not_found`). */
export class BlobStoreNotFound extends Schema.TaggedError<BlobStoreNotFound>()(
  "BlobStoreNotFound",
  {},
) {}

/** The store has been suspended, for example for exceeding the Hobby quota (`store_suspended`). */
export class BlobStoreSuspended extends Schema.TaggedError<BlobStoreSuspended>()(
  "BlobStoreSuspended",
  {},
) {}

/** The store cannot serve any request. */
export class BlobStoreUnavailable extends Schema.TaggedError<BlobStoreUnavailable>()(
  "BlobStoreUnavailable",
  {
    reason: Schema.Union([BlobStoreNotFound, BlobStoreSuspended]),
  },
) {}

/** A conditional write or delete found a different ETag than `ifMatch` (`precondition_failed`). */
export class BlobPreconditionFailed extends Schema.TaggedError<BlobPreconditionFailed>()(
  "BlobPreconditionFailed",
  {},
) {}

/** The upload's media type is not among the token's `allowedContentTypes`. */
export class ContentTypeNotAllowed extends Schema.TaggedError<ContentTypeNotAllowed>()(
  "ContentTypeNotAllowed",
  {
    message: Schema.String,
  },
) {}

/** The upload is larger than `maximumSizeInBytes`, checked locally or by the store. */
export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()("FileTooLarge", {
  message: Schema.String,
}) {}

/** The upload's pathname differs from the one the client token was issued for. */
export class PathnameMismatch extends Schema.TaggedError<PathnameMismatch>()("PathnameMismatch", {
  message: Schema.String,
}) {}

/** The client token's `validUntil` has passed. */
export class ClientTokenExpired extends Schema.TaggedError<ClientTokenExpired>()(
  "ClientTokenExpired",
  {},
) {}

/** The store refused an upload because it breaks a constraint of its token. */
export class BlobUploadRejected extends Schema.TaggedError<BlobUploadRejected>()(
  "BlobUploadRejected",
  {
    reason: Schema.Union([
      ContentTypeNotAllowed,
      FileTooLarge,
      PathnameMismatch,
      ClientTokenExpired,
    ]),
  },
) {}

/**
 * The operation needs a read-write or OIDC token and was called with a client token
 * (`client_token_not_allowed`), such as `rename`.
 */
export class BlobClientTokenNotAllowed extends Schema.TaggedError<BlobClientTokenNotAllowed>()(
  "BlobClientTokenNotAllowed",
  {
    message: Schema.String,
  },
) {}

/**
 * The project enables OIDC for Blob but not for the environment the token was issued in
 * (`oidc_environment_not_allowed`). Enable it in the store's settings or use a read-write token.
 */
export class BlobOidcEnvironmentNotAllowed extends Schema.TaggedError<BlobOidcEnvironmentNotAllowed>()(
  "BlobOidcEnvironmentNotAllowed",
  {
    message: Schema.String,
  },
) {}

/**
 * The operation signs with the store's read-write token, and none is configured. OIDC is not
 * enough for client tokens and their callbacks; set `BLOB_READ_WRITE_TOKEN`.
 */
export class BlobReadWriteTokenRequired extends Schema.TaggedError<BlobReadWriteTokenRequired>()(
  "BlobReadWriteTokenRequired",
  {
    operation: Schema.String,
  },
) {}

/** A presigned URL could not be signed: the token's scope or the options do not allow it. */
export class BlobPresignFailed extends Schema.TaggedError<BlobPresignFailed>()(
  "BlobPresignFailed",
  {
    message: Schema.String,
  },
) {}

/** The `x-vercel-signature` header is absent. */
export class SignatureMissing extends Schema.TaggedError<SignatureMissing>()(
  "SignatureMissing",
  {},
) {}

/** The `x-vercel-signature` header does not match the body. */
export class SignatureInvalid extends Schema.TaggedError<SignatureInvalid>()(
  "SignatureInvalid",
  {},
) {}

/** The request body is not a known upload event, or not JSON. */
export class EventMalformed extends Schema.TaggedError<EventMalformed>()("EventMalformed", {
  message: Schema.String,
}) {}

/** The presigned flow has no webhook public key: set `BLOB_WEBHOOK_PUBLIC_KEY`. */
export class WebhookPublicKeyMissing extends Schema.TaggedError<WebhookPublicKeyMissing>()(
  "WebhookPublicKeyMissing",
  {},
) {}

/**
 * An upload route received a request it must refuse. Respond with a 4xx: the blob store retries an
 * upload-completed callback that does not get a 200.
 */
export class BlobUploadEventRejected extends Schema.TaggedError<BlobUploadEventRejected>()(
  "BlobUploadEventRejected",
  {
    reason: Schema.Union([
      SignatureMissing,
      SignatureInvalid,
      EventMalformed,
      WebhookPublicKeyMissing,
    ]),
  },
) {}

/** The browser could not get a client token or presigned URL from the upload route. */
export class BlobUploadAuthorizationFailed extends Schema.TaggedError<BlobUploadAuthorizationFailed>()(
  "BlobUploadAuthorizationFailed",
  {
    /** The route's status code; none when the request failed before a response. */
    status: Schema.Option(Schema.Int),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
