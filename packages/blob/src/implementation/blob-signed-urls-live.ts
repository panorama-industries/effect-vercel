import { ApiBadRequest, VercelApiError, VercelOidc } from "@panorama-industries/effect-vercel-core";
import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/http";

import type { BlobAccess } from "../contracts/blob-domain.ts";
import type {
  IssueSignedTokenOptions,
  PresignOptions,
  SigningToken,
} from "../contracts/blob-signed-urls.ts";

import { BlobConfig } from "../contracts/blob-config.ts";
import { SignedToken } from "../contracts/blob-domain.ts";
import { BlobPresignFailed } from "../contracts/blob-errors.ts";
import { BlobSignedUrls } from "../contracts/blob-signed-urls.ts";
import { blobRequester, blobRequestSettings, serverBlobAuth } from "../internal/blob-request.ts";
import { presignedApiUrl, presignedBlobUrl, presignPayload } from "../internal/presign.ts";

/** `POST /signed-token`; `validUntil` is in epoch milliseconds. */
const SignedTokenResponse = Schema.Struct({
  delegationToken: Schema.String,
  clientSigningToken: Schema.RedactedFromValue(Schema.String),
  validUntil: Schema.DateTimeUtcFromMillis,
}).pipe(Schema.decodeTo(SignedToken));

/** The JSON body of `POST /signed-token`, with the SDK's keys in the SDK's order. */
const signedTokenBody = (options: IssueSignedTokenOptions): Record<string, unknown> => ({
  ...(options.pathname === undefined ? {} : { pathname: options.pathname }),
  ...(options.operations === undefined ? {} : { operations: [...new Set(options.operations)] }),
  ...(options.validUntil === undefined
    ? {}
    : { validUntil: DateTime.toEpochMillis(options.validUntil) }),
  ...(options.maximumSizeInBytes === undefined
    ? {}
    : { maximumSizeInBytes: options.maximumSizeInBytes }),
  ...(options.allowedContentTypes === undefined
    ? {}
    : { allowedContentTypes: options.allowedContentTypes }),
});

/**
 * Implements {@link BlobSignedUrls}: `issueSignedToken` calls the Blob API with the server
 * credentials of `BlobConfig` (OIDC or the read-write token); presigning is local and reads the
 * current time from `Clock`.
 */
export const BlobSignedUrlsLive: Layer.Layer<
  BlobSignedUrls,
  never,
  BlobConfig | HttpClient.HttpClient | VercelOidc
> = Layer.effect(
  BlobSignedUrls,
  Effect.gen(function* () {
    const config = yield* BlobConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const oidc = yield* VercelOidc;
    const requester = blobRequester(blobRequestSettings(config, httpClient));

    const issueSignedToken = Effect.fn("BlobSignedUrls.issueSignedToken")(function* (
      options: IssueSignedTokenOptions = {},
    ) {
      if (options.validUntil !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        if (DateTime.toEpochMillis(options.validUntil) <= now) {
          return yield* new VercelApiError({
            operation: "BlobSignedUrls.issueSignedToken",
            errorCode: Option.none(),
            reason: new ApiBadRequest({
              message: "`issueSignedToken`: validUntil must be in the future.",
            }),
          });
        }
      }
      return yield* requester.call({
        operation: "BlobSignedUrls.issueSignedToken",
        method: "POST",
        path: "/signed-token",
        auth: serverBlobAuth(config, oidc),
        json: signedTokenBody(options),
        response: SignedTokenResponse,
        domainErrors: ["BlobStoreUnavailable", "BlobOidcEnvironmentNotAllowed"],
      });
    });

    const presign = Effect.fn("BlobSignedUrls.presign")(function* (
      token: SigningToken,
      options: PresignOptions,
    ) {
      return yield* presignPayload(token, options, yield* Clock.currentTimeMillis);
    });

    const presignUrl = Effect.fn("BlobSignedUrls.presignUrl")(function* (
      token: SigningToken,
      options: PresignOptions & { readonly access: BlobAccess },
    ) {
      const payload = yield* presignPayload(token, options, yield* Clock.currentTimeMillis);
      switch (options.operation) {
        case "get":
        case "head": {
          const url = presignedBlobUrl({
            pathnameOrUrl: options.pathname,
            payload,
            access: options.access,
            useCache: options.operation === "get" ? options.useCache : undefined,
            blobBaseUrl: config.blobBaseUrl,
          });
          if (Option.isNone(url)) {
            return yield* new BlobPresignFailed({
              message: "Delegation token payload is missing `storeId`.",
            });
          }
          return url.value;
        }
        case "put":
        case "delete":
          return presignedApiUrl(config.apiUrl, options.pathname, payload);
      }
    });

    return BlobSignedUrls.of({ issueSignedToken, presign, presignUrl });
  }),
);
