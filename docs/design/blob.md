# Design: `effect-vercel-blob`

Reference implementation: `@vercel/blob@2.8.2` (source in
`../effect-vercel-reference-repos/storage/packages/blob`). Target runtime: `effect@4.x`.

Published as `@panorama-industries/effect-vercel-blob`; "blob" below. It depends on core
(`@panorama-industries/effect-vercel-core`) like queue does, and follows `docs/coding-standards.md`.

## Goals

- Effect-native client for Vercel Blob with feature parity for the server SDK (`@vercel/blob`) and
  the browser client (`@vercel/blob/client`).
- `@vercel/blob` is a spec and test oracle, never a runtime dependency.
- Runs on Node, Edge and browsers: Web Crypto and `effect` `Encoding` only, no `node:crypto`,
  `Buffer` or `undici`.

Porting rule (as for queue): reimplement what the SDK executes at runtime, with the same wire
protocol, and nothing more, except where listed under "Deliberate differences".

Non-goals for v1:

- Deprecated APIs: `putFromUrl` and `put({ optimizeImage })` (both replaced by `putImage`).
- Byte-level upload progress in browsers whose `fetch` cannot stream request bodies (Safari,
  Firefox). The SDK falls back to `XMLHttpRequest` there; Effect has no XHR client. Those browsers
  get coarse progress (0 % and 100 % for a single upload, one event per finished multipart part).
  An XHR `HttpClient` and browser-mode tests are v2.
- Per-call credentials (`token`, `oidcToken`, `storeId` options). Credentials come from
  `BlobConfig`; override them by providing another `blobConfigLayer({...})`. Browser calls take
  their client token or presigned payload explicitly because those are per upload by nature.

## Package layout

```text
packages/blob/
  src/
    contracts/
      blob-domain.ts         BlobAccess, StoreId, BlobPathname, ETag, PartNumber, results
      blob-errors.ts         domain errors
      blob-config.ts         BlobConfig (server)
      blob-store.ts          BlobStore: the server SDK
      blob-signed-urls.ts    BlobSignedUrls: issueSignedToken, presign, presignUrl
      blob-uploads.ts        BlobUploads: client tokens and upload route handlers
      blob-client.ts         BlobClient: browser uploads (exported from ./client)
    implementation/          <contract>-live.ts for each contract
    internal/
      blob-request.ts        request pipeline: auth, headers, error mapping, retry, progress
      blob-errors.ts         body error code -> domain error / VercelApiError
      multipart.ts           automatic multipart over Stream
      client-token.ts        client token encode/decode, HMAC
      presign.ts             canonical query entries and signing (presign-query-params port)
      callback.ts            callback URL derivation and signature verification
    index.ts                 server entry
    client.ts                browser entry (./client)
    testing/                 TestBlobStore: in-memory BlobStore
  test/differential/         side-by-side suite against @vercel/blob@2.8.2
  scripts/sdk-drift.mjs
```

`exports`: `.`, `./client`, `./testing`. The `./client` entry imports no server-only modules.

## Wire protocol (from the SDK)

All API calls go to `apiUrl` (default `https://vercel.com/api/blob`, override
`VERCEL_BLOB_API_URL` or `NEXT_PUBLIC_VERCEL_BLOB_API_URL`). Every API request carries:

| Header                            | Value                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `authorization`                   | `Bearer <token>`; absent for presigned requests                                |
| `x-api-version`                   | `13` (override `VERCEL_BLOB_API_VERSION_OVERRIDE` / `NEXT_PUBLIC_…`)           |
| `x-vercel-blob-store-id`          | bare store id (`store_` prefix stripped, case kept)                            |
| `x-api-blob-request-id`           | `<storeId>:<epoch ms>:<random hex>`, constant across retries                   |
| `x-api-blob-request-attempt`      | `0`, `1`, … per retry                                                          |
| `x-content-length`                | body length, only with upload progress or `VERCEL_BLOB_USE_X_CONTENT_LENGTH=1` |
| `x-proxy-through-alternative-api` | from `VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API` / `NEXT_PUBLIC_…`             |

Write options become headers: `x-vercel-blob-access` (always), `x-add-random-suffix` (`1`/`0`),
`x-allow-overwrite` (`1`/`0`; implied `1` when `ifMatch` is set), `x-content-type`,
`x-cache-control-max-age` (seconds), `x-if-match`. Which of them each endpoint accepts follows the
SDK's `allowedOptions` lists exactly.

| Operation                        | Request                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `put`                            | `PUT /?pathname=…`, raw body                                                                                                                                                        |
| `createFolder`                   | `PUT /?pathname=<p>/`, no body, `x-add-random-suffix: 0`                                                                                                                            |
| `putImage` (body)                | `POST /put-optimized?pathname&width&quality&format`                                                                                                                                 |
| `putImage` (URL)                 | `POST /put-from-url?pathname&url&width&quality&format`                                                                                                                              |
| `head`                           | `GET ?url=…` (no slash)                                                                                                                                                             |
| `list`                           | `GET ?limit&prefix&cursor&mode` (in that order)                                                                                                                                     |
| `del`                            | `POST /delete`, JSON `{"urls":[…]}`, optional `x-if-match`                                                                                                                          |
| `copy`                           | `PUT ?pathname=<to>&fromUrl=<from>`                                                                                                                                                 |
| `rename`                         | `POST /rename?pathname=<to>&fromUrl=<from>`                                                                                                                                         |
| multipart create/upload/complete | `POST /mpu?pathname=…` with `x-mpu-action: create\|upload\|complete`, `x-mpu-key` (URI-encoded), `x-mpu-upload-id`, `x-mpu-part-number`; complete sends JSON `[{etag, partNumber}]` |
| `issueSignedToken`               | `POST /signed-token`, JSON body                                                                                                                                                     |
| `get`                            | `GET` on the blob URL itself (`https://<storeId>.<access>.blob.vercel-storage.com/<p>`), `Bearer` token, optional `If-None-Match`, `?cache=0` for private + `useCache: false`       |

Presigned requests add the payload's params plus `vercel-blob-delegation` and
`vercel-blob-signature` to the query and send no `authorization`.

## Configuration: `BlobConfig`

```ts
{
  apiUrl: URL;
  auth: BlobAuth; // Oidc{ storeId } | ReadWrite{ token, storeId }
  readWriteToken: Option<Redacted<string>>; // OIDC fallback, client tokens, callback HMAC
  apiVersion: string; // "13"
  retries: number; // VERCEL_BLOB_RETRIES, default 10
  sendContentLength: boolean; // VERCEL_BLOB_USE_X_CONTENT_LENGTH === "1"
  headers: Record<string, string>; // x-proxy-through-alternative-api
  blobBaseUrl: (storeId, access) => URL; // where get(pathname) reads; tests redirect it
  webhookPublicKey: Option<string>; // BLOB_WEBHOOK_PUBLIC_KEY
  callbackBaseUrl: Option<string>; // VERCEL_BLOB_CALLBACK_URL
}
```

`BlobConfigLive` (from `Config` plus `VercelSystemEnv`) resolves credentials once, in the SDK's
order: explicit `token` option, then OIDC when a store id is known (`storeId` option or
`BLOB_STORE_ID`, either `store_<id>` or `<id>`), then `BLOB_READ_WRITE_TOKEN`; none of them is a
`ConfigError` at layer build. In OIDC mode each request evaluates `VercelOidc.token`; when it is
unavailable and a read-write token exists, the request uses the read-write token and its store id,
exactly like the SDK's fall-through. Store ids come from read-write tokens
(`vercel_blob_rw_<storeId>_…`) and client tokens (`vercel_blob_client_<storeId>_…`).

On Vercel functions, build the layers once at module scope (`ManagedRuntime` or
`HttpRouter.toWebHandler`) so warm Fluid instances reuse them across requests, including concurrent
ones. Layers therefore hold no per-request state; the OIDC token is read from each request.

## Errors

The SDK chooses errors from the JSON body (`{"error":{"code","message"}}`), not the status; a body
that is not JSON is `unknown_error`. Message rewrites happen first, exactly as in `getBlobError`
(`contentType … is not allowed`, `"pathname" … does not match the token payload`,
`Token expired`, `the file length cannot be greater than`, `OIDC is enabled for this project, but
not for the … environment.`).

| Body code                                                                                              | Effect error                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `not_found`                                                                                            | `BlobNotFound`                                                                                                 |
| `store_not_found`, `store_suspended`                                                                   | `BlobStoreUnavailable` (`StoreNotFound` \| `StoreSuspended`)                                                   |
| `precondition_failed`                                                                                  | `BlobPreconditionFailed`                                                                                       |
| `content_type_not_allowed`, `file_too_large`, `client_token_pathname_mismatch`, `client_token_expired` | `BlobUploadRejected` (`ContentTypeNotAllowed` \| `FileTooLarge` \| `PathnameMismatch` \| `ClientTokenExpired`) |
| `client_token_not_allowed`                                                                             | `BlobClientTokenNotAllowed`                                                                                    |
| `oidc_environment_not_allowed`                                                                         | `BlobOidcEnvironmentNotAllowed`                                                                                |
| `forbidden`                                                                                            | `VercelApiError` / `ApiForbidden`                                                                              |
| `bad_request`                                                                                          | `VercelApiError` / `ApiBadRequest`                                                                             |
| `rate_limited`                                                                                         | `VercelApiError` / `ApiRateLimited` (`Retry-After`)                                                            |
| `service_unavailable`, `unknown_error`, `not_allowed`, other                                           | `VercelApiError` mapped from the status (`ApiServerError` for 5xx, else `ApiUnexpectedResponse`)               |

`VercelApiError.errorCode` carries the body code. Transport failures are `ApiNetworkFailure`.
Input the SDK rejects at runtime is unrepresentable here instead: `BlobPathname` (non-empty, at
most 950 characters, no `//`), an `ifMatch`/`allowOverwrite` option union, `delMany` without
`ifMatch`, `PartNumber` (1–10000). `maximumSizeInBytes` exceeded before a multipart upload is
`BlobUploadRejected` / `FileTooLarge`, raised before any request.

## Retries

Same policy as the SDK: up to `retries` (default 10) retries, exponential backoff from 1 s with
jitter, `x-api-blob-request-attempt` incremented per attempt. Retried: `ApiNetworkFailure`, and
error bodies with code `unknown_error`, `service_unavailable` or `internal_server_error`. Not
retried: `rate_limited` and every other code. Built on core's `vercelApiTransientRetry` with a
custom predicate.

## Bodies, streaming and progress

```ts
type BlobBody<E = never, R = never> =
  | string
  | Uint8Array
  | globalThis.Blob
  | Stream.Stream<Uint8Array, E, R>;
```

The stream's `E` and `R` flow into the operation's types. Node `Readable` and web
`ReadableStream` are converted by the caller (`NodeStream.fromReadable`,
`Stream.fromReadableStream`).

`onUploadProgress: (event: UploadProgress) => Effect<void>` on `put`, multipart `put` and the browser
uploads. As in the SDK: the body is sent as a stream of 64 KiB chunks, events are throttled (100 ms
single, 150 ms multipart), `x-content-length` is sent, 0 % is reported before the request and 100 %
only after the response. On a runtime that cannot stream request bodies (detected like the SDK's
`supportsRequestStreams`) the body is sent whole and only those two events are reported.

`get` returns the response body as a `Stream<Uint8Array, VercelApiError>`; Effect 4's `HttpClient`
lets the body be read after the effect completes.

## Services

### `BlobStore` (`contracts/blob-store.ts`)

| Method                                                                   | Notes                                                                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `put(pathname, body, options)` → `PutBlobResult`                         | `options.multipart: true` uses automatic multipart                                                                     |
| `putImage(pathname, body \| URL, options)` → `PutBlobResult`             | requires OIDC on the server side                                                                                       |
| `head(pathnameOrUrl)` → `BlobMetadata`                                   | `BlobNotFound` when missing                                                                                            |
| `get(pathnameOrUrl, options)` → `GetBlobResult`                          | `Found{ body, headers, blob }` \| `NotModified{ headers, blob }`; `BlobNotFound` on 404                                |
| `list(options)` → `ListPage`                                             | `folders` is empty unless `mode: "folded"`                                                                             |
| `listAll(options)` → `Stream<ListedBlob>`                                | follows the cursor                                                                                                     |
| `del(pathnameOrUrl, { ifMatch? })`, `delMany(targets)`                   | missing blobs are not an error, except with `ifMatch` (`BlobPreconditionFailed`)                                       |
| `copy(from, to, options)`, `rename(from, to, options)` → `PutBlobResult` | `copy` always replaces `to`; `rename` needs `allowOverwrite`. A missing source is `BlobNotFound`                       |
| `createFolder(pathname, { access? })` → `CreateFolderResult`             | `access` defaults to `public`                                                                                          |
| `createMultipartUpload(pathname, options)` → `MultipartUpload`           | the handle carries pathname, key, upload id and the write options, so it can be serialized and used by another process |
| `uploadPart(upload, partNumber, body)` → `UploadedPart`                  |                                                                                                                        |
| `completeMultipartUpload(upload, parts)` → `PutBlobResult`               |                                                                                                                        |

Automatic multipart: the body stream is regrouped into 8 MiB parts (the last may be smaller) and
uploaded with `Stream.mapEffect(…, { concurrency: 8 })` (6 in browsers), then completed. Any failure
interrupts the other part uploads. Parts are not retried individually beyond the request retries.

### `BlobSignedUrls` (`contracts/blob-signed-urls.ts`)

`issueSignedToken(options)` (API call), `presign(token, options)` → `PresignedUrlPayload` and
`presignUrl(token, options)` → `URL` (local HMAC-SHA256, canonical string as the SDK's
`canonicalString`, validation as `presign-query-params.ts`). Failures are `BlobPresignFailed`.

### `BlobUploads` (`contracts/blob-uploads.ts`): server side of browser uploads

- `generateClientToken(options)` → `ClientToken`: `vercel_blob_client_<storeId>_<base64("<hex
  HMAC-SHA256(payload, rwToken)>.<base64 payload>")>`, default `validUntil` now + 30 s. Requires
  a read-write token (`BlobReadWriteTokenRequired` otherwise).
- `handler({ onBeforeGenerateToken, onUploadCompleted? })` → `Effect<HttpServerResponse, E |
  BlobUploadEventError, HttpServerRequest | R>`: answers `blob.generate-client-token` with
  `{ type, clientToken }` (default `validUntil` now + 1 h) and verifies `blob.upload-completed`
  callbacks (`x-vercel-signature`, HMAC-SHA256 hex keyed by the read-write token). Errors from the
  user's callbacks propagate so the route chooses the response.
- `presignedHandler({ getSignedToken, onUploadCompleted? })`: the `handleUploadPresigned`
  equivalent, answering `blob.generate-presigned-url` with `{ type, presignedUrlPayload }` and
  verifying callbacks with Ed25519 against `BLOB_WEBHOOK_PUBLIC_KEY`.

The callback URL is derived as in the SDK's `getCallbackUrl`: `callbackUrl` from the user,
else `VERCEL_BLOB_CALLBACK_URL` + request path, else on Vercel (`VERCEL=1`) the branch or
deployment URL for previews and the production URL for production; otherwise none, with a warning
log. Signatures are verified over `JSON.stringify(JSON.parse(rawBody))`, as the SDK does.

### `BlobClient` (`contracts/blob-client.ts`, `./client` entry)

`upload(pathname, body, { access, handleUploadUrl, clientPayload?, contentType?, multipart?,
headers?, onUploadProgress? })` and `uploadPresigned(...)`: fetch a client token or presigned
payload from the route (relative URLs resolve against `location.href`), then upload with it.
Plus the client-token primitives: `put`, `createMultipartUpload`, `uploadPart`,
`completeMultipartUpload`, which accept only `access` and `contentType` (the rest is fixed by the
token). `BlobClientLive` needs only `HttpClient`; `blobClientLayer({ apiUrl? })` overrides the
API URL.

## Deliberate differences from the SDK

- `get` fails with `BlobNotFound` on 404 instead of returning `null`, matching `head`.
- The store reports a missing key as `bad_request` with the message "The specified key does not
  exist." instead of a code. The SDK throws a generic `BlobError`; we map it to `BlobNotFound` for a
  missing `copy` or `rename` source and to `BlobPreconditionFailed` for `ifMatch` on a missing blob
  (HTTP's `If-Match` semantics). Only that exact message is mapped; `pnpm test:live` checks it.
- A request whose body is a one-shot stream is not retried (the SDK resends a consumed stream).
- Credentials are chosen when the layer is built, not per call.
- A read-write token from which no store id can be parsed is a `ConfigError`, not an empty
  `x-vercel-blob-store-id` header.
- Invalid input fails at construction (branded types, option unions) instead of throwing
  `BlobError` at call time.
- `list` always returns `folders` (empty unless folded) instead of two result types.
- Each operation reports only the domain errors its contract declares; any other domain code in an
  error body (say `not_found` from `put`) becomes a `VercelApiError` keeping the code in
  `errorCode`. For codes outside the table the reason comes from the HTTP status and keeps the
  server's message, where the SDK uses its fixed "Unknown error" text.
- Result URLs are `URL` objects, so their host is lower-cased (`storeid.public…`); the SDK returns
  raw strings.
- Automatic multipart completes with the parts sorted by part number; the SDK sends them in the
  order they finished. Progress reports 0 % after creation and 100 % only after completion.
- `issueSignedToken` with a `validUntil` that is not in the future fails locally with
  `ApiBadRequest` and sends nothing.
- An upload-completed callback's payload is decoded (`PutBlobResult`) before `onUploadCompleted`
  runs; the SDK passes it on unchecked.
- `BlobConfigLive` and `BlobClientLive` trim every variable, treat blank ones as absent, and reject
  an invalid API URL, store id or `VERCEL_BLOB_RETRIES` with a `ConfigError`.
- Blob requests carry no `traceparent`, for wire parity and to avoid CORS preflights in browsers.

The differential suite (`test/differential/`) asserts every difference above that is observable on
the wire or in outcomes; anything else it finds is a bug.

## Core additions

- `VercelSystemEnv`: `isVercel` (`VERCEL=1`), `branchUrl` (`VERCEL_BRANCH_URL`),
  `projectProductionUrl` (`VERCEL_PROJECT_PRODUCTION_URL`), for the callback URL.
- `vercelApiErrorFromStatus`: builds a `VercelApiError` from an already-read body's code and
  message.
- `vercelApiTransientRetry({ isRetryable })`: custom retry predicate.

## Testing

- Unit tests per `*Live` layer against `TestHttpServer`, porting the SDK's Jest suites
  (`index.node`, `api.node`, `client.node`, `client.browser` (as Node contract tests),
  `put-image`, the presign shared spec, the presign `get` tests), roughly 200 cases. Golden vectors
  (client tokens at a fixed clock, callback HMACs) are copied verbatim.
- Differential: `@vercel/blob@2.8.2` pinned exactly. The SDK reads `process.env` per call, so the
  harness sets `VERCEL_BLOB_API_URL` to the test server, `VERCEL_BLOB_RETRIES=0`,
  `BLOB_READ_WRITE_TOKEN` (or `VERCEL_OIDC_TOKEN` with a far-future JWT plus `BLOB_STORE_ID`).
  Both clients run the same operation; assert identical method, path, query, headers (request id by
  shape only) and body, and equivalent outcomes for every body error code. `get` uses blob URLs on
  the test server's origin, which the SDK allows when `VERCEL_BLOB_API_URL` is set. Client tokens,
  presign payloads and callback verification are compared byte for byte at a fixed clock.
- `scripts/sdk-drift.mjs`: diff the pinned SDK against a newer version.
- Conformance (`test/live`, `pnpm test:live`): each scenario runs against real stores through
  `BlobStoreLive` and against `TestBlobStore`, and the outcomes must match. Needs
  `BLOB_READ_WRITE_TOKEN_PRIVATE` and `BLOB_READ_WRITE_TOKEN_PUBLIC` (one store of each access) in
  `.env`; a store without a token is skipped, and `pnpm test` never runs it. This is the source for
  server behavior the SDK does not show: overwrite rules, `contentDisposition`, `cacheControl`,
  media type inference, store access and `ifMatch` on missing blobs.

## Build order

1. Contracts, scaffolding, core additions, request pipeline (`internal/blob-request.ts`,
   `internal/blob-errors.ts`, `BlobConfigLive`). Reviewed before fan-out.
2. In parallel, against the contracts and pipeline:
   - A: `BlobStoreLive` except multipart, with ported tests.
   - B: multipart (automatic and manual) and upload progress.
   - C: `BlobSignedUrls`, `BlobUploads`, client tokens, callback verification.
   - D: `BlobClient` and the `./client` entry.
   - E: differential harness and suite.
3. `TestBlobStore`, README, changeset, `npm publish --dry-run`.
