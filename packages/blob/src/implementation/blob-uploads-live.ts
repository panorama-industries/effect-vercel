import { VercelSystemEnv } from "@panorama-industries/effect-vercel-core";
import { Clock, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import type {
  ClientTokenOptions,
  PresignedUploadHandlerOptions,
  UploadHandlerOptions,
} from "../contracts/blob-uploads.ts";
import type { ClientTokenFields } from "../internal/client-token.ts";

import { BlobConfig } from "../contracts/blob-config.ts";
import { UploadCompleted, UploadRequest } from "../contracts/blob-domain.ts";
import {
  BlobReadWriteTokenRequired,
  BlobUploadEventRejected,
  EventMalformed,
  SignatureInvalid,
  SignatureMissing,
  WebhookPublicKeyMissing,
} from "../contracts/blob-errors.ts";
import { BlobUploads } from "../contracts/blob-uploads.ts";
import {
  callbackSignatureHeader,
  deriveCallbackUrl,
  parseCallbackBody,
  resolveCallbackUrl,
  verifyEd25519CallbackSignature,
  verifyHmacCallbackSignature,
} from "../internal/callback.ts";
import {
  clientTokenPayloadJson,
  contradictsIfMatch,
  defaultClientTokenLifetimeMillis,
  ifMatchContradictionMessage,
  signClientToken,
} from "../internal/client-token.ts";
import { presignPayload } from "../internal/presign.ts";
import { storeIdFromReadWriteToken } from "../internal/store-id.ts";
import { PutBlobResponse } from "../internal/wire.ts";

/** How long a client token issued by an upload route stays valid by default, as the SDK. */
const uploadRouteTokenLifetimeMillis = 60 * 60 * 1000;

const generateClientTokenEvent = "blob.generate-client-token";
const generatePresignedUrlEvent = "blob.generate-presigned-url";
const uploadCompletedEvent = "blob.upload-completed";

/** What the browser sends to start an upload; extra fields (such as a `callbackUrl`) are ignored. */
const UploadRequestPayload = Schema.Struct({
  pathname: Schema.String,
  clientPayload: Schema.OptionFromOptionalNullOr(Schema.String),
  multipart: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}).pipe(Schema.decodeTo(UploadRequest));

/** The `payload` of `blob.upload-completed`. */
const UploadCompletedPayload = Schema.Struct({
  blob: PutBlobResponse,
  tokenPayload: Schema.OptionFromOptionalNullOr(Schema.String),
}).pipe(Schema.decodeTo(UploadCompleted));

const UploadRouteEvent = Schema.Struct({
  type: Schema.Literals([generateClientTokenEvent, uploadCompletedEvent]),
  payload: Schema.Unknown,
});

const PresignedRouteEvent = Schema.Struct({
  type: Schema.Literals([generatePresignedUrlEvent, uploadCompletedEvent]),
  payload: Schema.Unknown,
});

const rejected = (reason: BlobUploadEventRejected["reason"]) =>
  new BlobUploadEventRejected({ reason });

const malformed = (message: string) => rejected(new EventMalformed({ message }));

const decodeOrReject = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((error) => malformed(error.message)),
  );

/**
 * The request's body as the SDK receives it (`await request.json()`), and as callback signatures
 * cover it. A body that cannot be read or is not JSON is `EventMalformed`.
 */
const readEvent = <S extends Schema.Decoder<{ readonly type: string; readonly payload: unknown }>>(
  schema: S,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text.pipe(
      Effect.mapError(() => malformed("The request body could not be read.")),
    );
    const body = yield* Option.match(parseCallbackBody(text), {
      onNone: () => Effect.fail(malformed("The request body is not JSON.")),
      onSome: Effect.succeed,
    });
    const event = yield* Schema.decodeUnknownEffect(schema)(body.json).pipe(
      Effect.mapError(() => malformed("Invalid event type")),
    );
    return { request, event, normalizedBody: body.normalized };
  });

const signatureOf = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const signature = request.headers[callbackSignatureHeader] ?? "";
    if (signature === "") {
      return yield* rejected(new SignatureMissing());
    }
    return signature;
  });

/**
 * Fields of a client token or route authorization in wire form and in the caller's key order,
 * which the SDK serializes as given: `validUntil` becomes epoch milliseconds, unknown keys are
 * dropped.
 */
const wireFields = (
  options: object,
  keys: ReadonlySet<string>,
  except?: string,
): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!keys.has(key) || key === except) continue;
    fields[key] =
      key === "validUntil" && DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : value;
  }
  return fields;
};

const constraintKeys = [
  "maximumSizeInBytes",
  "allowedContentTypes",
  "validUntil",
  "addRandomSuffix",
  "allowOverwrite",
  "cacheControlMaxAge",
  "ifMatch",
];

const clientTokenOptionKeys: ReadonlySet<string> = new Set([
  "pathname",
  "onUploadCompleted",
  ...constraintKeys,
]);

const uploadAuthorizationKeys: ReadonlySet<string> = new Set([
  "tokenPayload",
  "callbackUrl",
  ...constraintKeys,
]);

/**
 * Implements {@link BlobUploads} with the store's read-write token from `BlobConfig` (client tokens
 * and their callbacks) and `BlobConfig.webhookPublicKey` (presigned callbacks). Callback URLs are
 * derived from `BlobConfig.callbackBaseUrl` and `VercelSystemEnv`; the time comes from `Clock`.
 */
export const BlobUploadsLive: Layer.Layer<BlobUploads, never, BlobConfig | VercelSystemEnv> =
  Layer.effect(
    BlobUploads,
    Effect.gen(function* () {
      const config = yield* BlobConfig;
      const systemEnv = yield* VercelSystemEnv;

      const readWriteToken = (operation: string) =>
        Option.match(config.readWriteToken, {
          onNone: () => Effect.fail(new BlobReadWriteTokenRequired({ operation })),
          onSome: (token) => Effect.succeed(Redacted.value(token)),
        });

      /** The SDK's `generateClientTokenFromReadWriteToken`, over fields already in wire form. */
      const signFields = Effect.fnUntraced(function* (
        token: string,
        fields: ClientTokenFields,
        now: number,
      ) {
        if (contradictsIfMatch(fields)) {
          return yield* Effect.die(new Error(ifMatchContradictionMessage));
        }
        const storeId = storeIdFromReadWriteToken(token);
        if (Option.isNone(storeId)) {
          return yield* Effect.die(new Error("Invalid `BLOB_READ_WRITE_TOKEN`"));
        }
        const payload = clientTokenPayloadJson(fields, now + defaultClientTokenLifetimeMillis);
        return yield* signClientToken(token, storeId.value, payload);
      });

      const callbackUrlFor = (
        request: HttpServerRequest.HttpServerRequest,
        provided: string | undefined,
        handlesCallback: boolean,
      ) =>
        resolveCallbackUrl({
          provided,
          handlesCallback,
          derive: deriveCallbackUrl({
            requestUrl: request.originalUrl,
            callbackBaseUrl: config.callbackBaseUrl,
            env: systemEnv,
          }),
        });

      const generateClientToken = Effect.fn("BlobUploads.generateClientToken")(function* (
        options: ClientTokenOptions,
      ) {
        const token = yield* readWriteToken("BlobUploads.generateClientToken");
        const now = yield* Clock.currentTimeMillis;
        return yield* signFields(token, wireFields(options, clientTokenOptionKeys), now);
      });

      const handler = Effect.fn("BlobUploads.handler")(function* <E, R, E2, R2>(
        options: UploadHandlerOptions<E, R, E2, R2>,
      ) {
        const token = yield* readWriteToken("BlobUploads.handler");
        const { request, event, normalizedBody } = yield* readEvent(UploadRouteEvent);
        switch (event.type) {
          case "blob.generate-client-token": {
            const uploadRequest = yield* decodeOrReject(UploadRequestPayload, event.payload);
            const authorization = yield* options.onBeforeGenerateToken(uploadRequest);
            const tokenPayload =
              authorization.tokenPayload ?? Option.getOrNull(uploadRequest.clientPayload);
            const callbackUrl = yield* callbackUrlFor(
              request,
              authorization.callbackUrl,
              options.onUploadCompleted !== undefined,
            );
            const now = yield* Clock.currentTimeMillis;
            const validUntil =
              authorization.validUntil === undefined
                ? now + uploadRouteTokenLifetimeMillis
                : DateTime.toEpochMillis(authorization.validUntil);
            const clientToken = yield* signFields(
              token,
              {
                ...wireFields(authorization, uploadAuthorizationKeys, "callbackUrl"),
                pathname: uploadRequest.pathname,
                onUploadCompleted: Option.match(callbackUrl, {
                  onNone: () => undefined,
                  onSome: (url) => ({ callbackUrl: url, tokenPayload }),
                }),
                validUntil,
              },
              now,
            );
            return HttpServerResponse.jsonUnsafe({ type: event.type, clientToken });
          }
          case "blob.upload-completed": {
            const signature = yield* signatureOf(request);
            const verified = yield* verifyHmacCallbackSignature(token, signature, normalizedBody);
            if (!verified) {
              return yield* rejected(new SignatureInvalid());
            }
            if (options.onUploadCompleted !== undefined) {
              const completed = yield* decodeOrReject(UploadCompletedPayload, event.payload);
              yield* options.onUploadCompleted(completed);
            }
            return HttpServerResponse.jsonUnsafe({ type: event.type, response: "ok" });
          }
        }
      });

      const presignedHandler = Effect.fn("BlobUploads.presignedHandler")(function* <E, R, E2, R2>(
        options: PresignedUploadHandlerOptions<E, R, E2, R2>,
      ) {
        if (Option.isNone(config.webhookPublicKey)) {
          return yield* rejected(new WebhookPublicKeyMissing());
        }
        const webhookPublicKey = config.webhookPublicKey.value;
        const { request, event, normalizedBody } = yield* readEvent(PresignedRouteEvent);
        switch (event.type) {
          case "blob.generate-presigned-url": {
            const uploadRequest = yield* decodeOrReject(UploadRequestPayload, event.payload);
            const { token, urlOptions = {} } = yield* options.getSignedToken(uploadRequest);
            const { callbackUrl: providedCallbackUrl, tokenPayload, ...putOptions } = urlOptions;
            const callbackTokenPayload =
              tokenPayload ?? Option.getOrUndefined(uploadRequest.clientPayload);
            const callbackUrl = yield* callbackUrlFor(
              request,
              providedCallbackUrl,
              options.onUploadCompleted !== undefined,
            );
            const payload = yield* presignPayload(
              token,
              {
                ...putOptions,
                onUploadCompleted: Option.match(callbackUrl, {
                  onNone: () => undefined,
                  onSome: (url) => ({ callbackUrl: url, tokenPayload: callbackTokenPayload }),
                }),
                operation: "put",
                pathname: uploadRequest.pathname,
              },
              yield* Clock.currentTimeMillis,
            );
            return HttpServerResponse.jsonUnsafe({
              type: event.type,
              presignedUrlPayload: {
                delegationToken: payload.delegationToken,
                signature: payload.signature,
                params: payload.params,
              },
            });
          }
          case "blob.upload-completed": {
            const signature = yield* signatureOf(request);
            const verified = yield* verifyEd25519CallbackSignature(
              webhookPublicKey,
              signature,
              normalizedBody,
            );
            if (!verified) {
              return yield* rejected(new SignatureInvalid());
            }
            if (options.onUploadCompleted !== undefined) {
              const completed = yield* decodeOrReject(UploadCompletedPayload, event.payload);
              yield* options.onUploadCompleted(completed);
            }
            return HttpServerResponse.jsonUnsafe({ type: event.type, response: "ok" });
          }
        }
      });

      return BlobUploads.of({ generateClientToken, handler, presignedHandler });
    }),
  );
