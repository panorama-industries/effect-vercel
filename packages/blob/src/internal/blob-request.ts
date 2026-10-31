import type { OidcTokenUnavailable, VercelOidc } from "@panorama-industries/effect-vercel-core";
import type { HttpClientError, HttpClientResponse } from "effect/http";

import {
  ApiUnexpectedResponse,
  VercelApiError,
  vercelApiErrorFromHttpClientError,
  vercelApiTransientRetry,
} from "@panorama-industries/effect-vercel-core";
import {
  Clock,
  Data,
  Duration,
  Effect,
  Fiber,
  Option,
  Queue,
  Random,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";

import type { BlobConfig } from "../contracts/blob-config.ts";
import type {
  BlobBody,
  OnUploadProgress,
  PresignedUrlPayload,
  UploadProgress,
} from "../contracts/blob-domain.ts";
import type { BlobApiError, BlobDomainErrorTag } from "./blob-errors.ts";

import { BlobAuth } from "../contracts/blob-config.ts";
import { blobErrorFromHttpResponse, isRetryableBlobError } from "./blob-errors.ts";
import { storeIdFromReadWriteToken } from "./store-id.ts";

/**
 * What every request of one component shares; build it once per layer, from `BlobConfig` with
 * {@link blobRequestSettings} on the server, or from the client options in the browser.
 */
export interface BlobRequestSettings {
  readonly httpClient: HttpClient.HttpClient;

  /** Blob API base URL; a call's `path` is appended to it after removing trailing slashes. */
  readonly apiUrl: URL;

  /** Sent as `x-api-version`. */
  readonly apiVersion: string;

  /** Retries after the first attempt; a call whose body is a `Stream` makes one attempt only. */
  readonly retries: number;

  /** Send `x-content-length` on every call, not only on calls with upload progress. */
  readonly sendContentLength: boolean;

  /** Sent with every call, after the protocol headers and before the call's own headers. */
  readonly headers: Readonly<Record<string, string>>;

  /**
   * Whether `fetch` can stream request bodies; detected with {@link supportsRequestStreams} when
   * omitted. When false, bodies are sent whole (streams are read into memory first) and upload
   * progress reports only 0 % and 100 %.
   */
  readonly streamRequestBodies?: boolean | undefined;
}

/** Settings for server-side services, read from `BlobConfig`. */
export const blobRequestSettings = (
  config: BlobConfig["Service"],
  httpClient: HttpClient.HttpClient,
): BlobRequestSettings => ({
  httpClient,
  apiUrl: config.apiUrl,
  apiVersion: config.apiVersion,
  retries: config.retries,
  sendContentLength: config.sendContentLength,
  headers: config.headers,
});

/** How one call authenticates, resolved once per call (before the first attempt). */
export type BlobRequestAuth = Data.TaggedEnum<{
  /**
   * `authorization: Bearer <token>`, for read-write, OIDC and client tokens. `storeId` goes into
   * `x-vercel-blob-store-id` and the request id.
   */
  Bearer: { readonly token: Redacted.Redacted<string>; readonly storeId: string };
  /**
   * No `authorization`; the payload's `params`, `vercel-blob-delegation` and
   * `vercel-blob-signature` are set on the query. Take `storeId` from the delegation token with
   * `storeIdFromDelegationToken`.
   */
  Presigned: { readonly payload: PresignedUrlPayload; readonly storeId: string };
}>;

/** Constructors and matchers for {@link BlobRequestAuth}. */
export const BlobRequestAuth = Data.taggedEnum<BlobRequestAuth>();

/**
 * The per-call auth of server-side services. `ReadWrite` uses its token. `Oidc` evaluates
 * `VercelOidc.token` on every call; when it is unavailable and `BlobConfig.readWriteToken` is set,
 * the call uses that token and its store id instead, as the SDK falls through to
 * `BLOB_READ_WRITE_TOKEN`. Otherwise it fails with the `OidcTokenUnavailable`.
 */
export const serverBlobAuth = (
  config: BlobConfig["Service"],
  oidc: VercelOidc["Service"],
): Effect.Effect<BlobRequestAuth, OidcTokenUnavailable> => {
  const fallback = Option.flatMap(config.readWriteToken, (token) =>
    Option.map(storeIdFromReadWriteToken(Redacted.value(token)), (storeId) =>
      BlobRequestAuth.Bearer({ token, storeId }),
    ),
  );
  return BlobAuth.$match(config.auth, {
    ReadWrite: ({ token, storeId }) => Effect.succeed(BlobRequestAuth.Bearer({ token, storeId })),
    Oidc: ({ storeId }) =>
      oidc.token.pipe(
        Effect.map((token) => BlobRequestAuth.Bearer({ token, storeId })),
        Effect.catchTag("OidcTokenUnavailable", (error) =>
          Option.match(fallback, {
            onNone: () => Effect.fail(error),
            onSome: Effect.succeed,
          }),
        ),
      ),
  });
};

/** HTTP methods the Blob API uses. */
export type BlobRequestMethod = "GET" | "PUT" | "POST" | "DELETE";

/**
 * One Blob API call for {@link BlobRequester} `call`.
 *
 * @template A - Decoded response body; `void` when `response` is omitted.
 * @template E - Failure of a `Stream` body, reported as is (not as a network failure).
 * @template R - Requirements of a `Stream` body.
 * @template EA - Failure of `auth`, such as `OidcTokenUnavailable`.
 * @template K - Domain errors the operation reports; other domain codes become `VercelApiError`.
 */
export interface BlobApiCall<A, E, R, EA, RA, K extends BlobDomainErrorTag> {
  /** Traced name, such as `BlobStore.put`; stored in `VercelApiError.operation`. */
  readonly operation: string;

  readonly method: BlobRequestMethod;

  /**
   * Path and query appended to the API URL exactly as the SDK appends it: `/?pathname=…` for put,
   * `?url=…` (no slash) for head, `?limit…` for list, `/delete`, `/mpu?pathname=…`. Build queries
   * with `URLSearchParams` so they are encoded like the SDK's.
   */
  readonly path: string;

  readonly auth: Effect.Effect<BlobRequestAuth, EA, RA>;

  /** Decodes the JSON response body (see `internal/wire.ts`); omit to ignore the body. */
  readonly response?: Schema.Decoder<A> | undefined;

  /** Sent last, so they override every other header (including `authorization`). */
  readonly headers?: Readonly<Record<string, string>> | undefined;

  /** Raw request body. Strings, bytes and `Blob`s are resent on retries; streams are not. */
  readonly body?: BlobBody<E, R> | undefined;

  /**
   * A JSON request body, sent as `JSON.stringify(json)` with `content-type: application/json`
   * (before `headers`). Takes precedence over `body`.
   */
  readonly json?: unknown;

  /** What `BlobNotFound.locator` reports for `not_found`; defaults to `path`. */
  readonly locator?: string | undefined;

  /** Domain errors the operation surfaces; all by default. See `blobErrorFromResponse`. */
  readonly domainErrors?: ReadonlyArray<K> | undefined;

  /**
   * Upload progress, reported as the SDK does: `{ loaded: 0, total, percentage: 0 }` before the
   * first attempt, then once per 64 KiB chunk sent (never 100 % while waiting for the response),
   * then `{ loaded, total: loaded, percentage: 100 }` once a successful response arrived. Also sends
   * `x-content-length`. Where `fetch` cannot stream request bodies, only the first and last events
   * are reported.
   */
  readonly onUploadProgress?: OnUploadProgress | undefined;

  /**
   * Minimum time between chunk events (leading and trailing edge, like `throttleit`); the SDK uses
   * 100 ms for `put`. The first and last events are never delayed. Unthrottled when omitted.
   */
  readonly progressInterval?: Duration.Input | undefined;
}

/** A GET on a blob's own URL, for `get`: no Blob API headers, no retries. */
export interface BlobFetchRequest {
  /** Traced name, such as `BlobStore.get`; stored in `VercelApiError.operation`. */
  readonly operation: string;

  readonly url: URL;

  /** Sent as `authorization: Bearer <token>`. */
  readonly token: Redacted.Redacted<string>;

  /** Sent after `authorization`, so they override it; put `if-none-match` here. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** Executes Blob API calls with the SDK's headers, retries, error mapping and progress. */
export interface BlobRequester {
  /**
   * Send one API call, retrying it like the SDK's `requestApi`, and decode the response.
   *
   * Every attempt carries `x-api-blob-request-id` (`<storeId>:<epoch ms>:<random hex>`, the same
   * for all attempts), `x-api-blob-request-attempt` (`0`, `1`, …), `x-api-version`,
   * `x-vercel-blob-store-id`, `authorization` for bearer auth, `x-content-length` with progress or
   * `sendContentLength`, then the settings' headers, then the call's headers. Network failures and
   * retryable error codes (`isRetryableBlobError`) are retried up to `retries` times with
   * exponential backoff from 1 second; a `Stream` body is sent once.
   *
   * @returns The decoded body; fails with `VercelApiError` (`ApiNetworkFailure` for transport
   *   failures, `ApiUnexpectedResponse` for a body `response` cannot decode), a domain error among
   *   `domainErrors`, the auth effect's error, or the body stream's error.
   */
  readonly call: <
    A = void,
    E = never,
    R = never,
    EA = never,
    RA = never,
    K extends BlobDomainErrorTag = BlobDomainErrorTag,
  >(
    call: BlobApiCall<A, E, R, EA, RA, K>,
  ) => Effect.Effect<A, BlobApiError<K> | E | EA, R | RA>;

  /**
   * Send a GET to a blob URL and return the response whatever its status; the caller maps 304,
   * 404 and other statuses. Transport failures are `VercelApiError` / `ApiNetworkFailure`.
   */
  readonly fetch: (
    request: BlobFetchRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, VercelApiError>;
}

/** Size of the chunks a progress-tracked body is sent in, as the SDK's `CHUNK_SIZE`. */
export const progressChunkSize = 64 * 1024;

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
};

/**
 * Regroup a byte stream into chunks of exactly `size` bytes, the last one possibly smaller, like
 * the SDK's `createChunkTransformStream`. Empty input chunks produce nothing.
 */
export const chunkBytes =
  (size: number) =>
  <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
    Stream.mapAccum(
      stream,
      () => new Uint8Array(0),
      (pending: Uint8Array, chunk: Uint8Array) => {
        let buffer = pending.length === 0 ? chunk : concatBytes(pending, chunk);
        const out: Array<Uint8Array> = [];
        while (buffer.length >= size) {
          out.push(buffer.slice(0, size));
          buffer = buffer.subarray(size);
        }
        return [buffer, out] as const;
      },
      { onHalt: (buffer) => (buffer.length > 0 ? [buffer.slice()] : []) },
    );

const textEncoder = new TextEncoder();

const isBlob = (body: unknown): body is globalThis.Blob =>
  typeof globalThis.Blob !== "undefined" && body instanceof globalThis.Blob;

const isStreamBody = <E, R>(body: BlobBody<E, R>): body is Stream.Stream<Uint8Array, E, R> =>
  Stream.isStream(body);

/**
 * Bytes a body will send when known up front, as the SDK's `computeBodyLength`: UTF-8 length of a
 * string, byte length, `Blob` size; 0 for a stream.
 */
export const bodyLength = <E, R>(body: BlobBody<E, R>): number => {
  if (typeof body === "string") return textEncoder.encode(body).byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  if (isBlob(body)) return body.size;
  return 0;
};

/** A body as a stream of bytes. A `Blob` that cannot be read is a defect. */
export const bodyStream = <E, R>(body: BlobBody<E, R>): Stream.Stream<Uint8Array, E, R> => {
  if (typeof body === "string") return Stream.succeed(textEncoder.encode(body));
  if (body instanceof Uint8Array) return Stream.succeed(body);
  if (isBlob(body)) {
    return Stream.fromReadableStream({
      evaluate: () => body.stream(),
      onError: (cause) => cause,
    }).pipe(Stream.orDie);
  }
  return body;
};

const isNodeProcess = (): boolean => {
  if (typeof navigator !== "undefined" && navigator.product === "ReactNative") return true;
  const process = (
    globalThis as {
      readonly process?: { readonly type?: string; readonly versions?: { readonly node?: string } };
    }
  ).process;
  if (process === undefined) return false;
  if (process.type === "renderer" || process.type === "worker") return false;
  return process.versions?.node !== undefined;
};

/**
 * Whether `fetch` can stream a request body here, detected like the SDK's
 * `supportsRequestStreams`: always on Node; never against `http://localhost` (no HTTP/2); otherwise
 * when `Request` reads the `duplex` option and does not type a stream body (Chromium, Edge
 * runtimes, not Safari or Firefox).
 */
export const supportsRequestStreams = (apiUrl: string): boolean => {
  if (isNodeProcess()) return true;
  if (apiUrl.startsWith("http://localhost")) return false;
  try {
    let duplexAccessed = false;
    const init = {
      body: new ReadableStream(),
      method: "POST",
      get duplex() {
        duplexAccessed = true;
        return "half";
      },
    };
    const hasContentType = new Request(apiUrl, init as RequestInit).headers.has("Content-Type");
    return duplexAccessed && !hasContentType;
  } catch {
    return false;
  }
};

/** Delivers progress events, possibly throttled; see {@link uploadProgressThrottle}. */
export interface UploadProgressReporter {
  readonly report: (progress: UploadProgress) => Effect.Effect<void>;

  /** Drop any event still waiting for its interval and stop reporting. */
  readonly stop: Effect.Effect<void>;
}

/**
 * Throttle progress events like `throttleit`, which the SDK wraps `onUploadProgress` in: the first
 * event after a quiet interval is reported at once, later ones at most once per `interval`, and the
 * latest event of an interval is reported when it ends (earlier ones are dropped).
 *
 * The interval starts now, as if an event had just been reported (callers report 0 % first). Call
 * `stop` before the final 100 % event, which callers report directly so it is never delayed.
 * Without an interval (or a zero one), events are reported immediately.
 */
export const uploadProgressThrottle = Effect.fnUntraced(function* (
  onUploadProgress: OnUploadProgress,
  interval: Duration.Input | undefined,
): Effect.fn.Return<UploadProgressReporter> {
  if (interval === undefined || Duration.isZero(Duration.fromInputUnsafe(interval))) {
    return { report: onUploadProgress, stop: Effect.void };
  }
  const latest = yield* Queue.sliding<UploadProgress>(1);
  const fiber = yield* Effect.forkChild(
    Effect.sleep(interval).pipe(
      Effect.andThen(
        Effect.forever(
          Queue.take(latest).pipe(
            Effect.flatMap(onUploadProgress),
            Effect.andThen(Effect.sleep(interval)),
          ),
        ),
      ),
    ),
  );
  return {
    report: (progress) => Effect.asVoid(Queue.offer(latest, progress)),
    stop: Fiber.interrupt(fiber),
  };
});

const unexpectedResponse = (operation: string, status: number, message: string) =>
  new VercelApiError({
    operation,
    errorCode: Option.none(),
    reason: new ApiUnexpectedResponse({ message, status }),
  });

const withoutTracePropagation = Effect.provideService(HttpClient.TracerPropagationEnabled, false);

/**
 * Build the {@link BlobRequester} that every service uses for Blob API calls.
 *
 * Requests carry no `traceparent`/`b3` headers (the SDK sends none, and browsers would need CORS
 * approval for them); the HTTP client still records a span per attempt.
 */
export const blobRequester = (settings: BlobRequestSettings): BlobRequester => {
  const baseUrl = settings.apiUrl.href.replace(/\/+$/, "");
  const streamsSupported =
    settings.streamRequestBodies ?? supportsRequestStreams(settings.apiUrl.href);
  const client = settings.httpClient;

  const requestUrl = (path: string, auth: BlobRequestAuth): string => {
    const url = `${baseUrl}${path}`;
    return BlobRequestAuth.$match(auth, {
      Bearer: () => url,
      Presigned: ({ payload }) => {
        const presigned = new URL(url);
        for (const [key, value] of Object.entries(payload.params)) {
          presigned.searchParams.set(key, value);
        }
        presigned.searchParams.set("vercel-blob-delegation", payload.delegationToken);
        presigned.searchParams.set("vercel-blob-signature", payload.signature);
        return presigned.toString();
      },
    });
  };

  const call = Effect.fnUntraced(function* <
    A,
    E,
    R,
    EA,
    RA,
    K extends BlobDomainErrorTag = BlobDomainErrorTag,
  >(call: BlobApiCall<A, E, R, EA, RA, K>): Effect.fn.Return<A, BlobApiError<K> | E | EA, R | RA> {
    const { operation } = call;
    const auth = yield* call.auth;
    const url = requestUrl(call.path, auth);
    const now = yield* Clock.currentTimeMillis;
    const random = yield* Random.next;
    const requestId = `${auth.storeId}:${now}:${random.toString(16).slice(2)}`;

    const body: BlobBody<E, R> | undefined =
      call.json === undefined ? call.body : JSON.stringify(call.json);
    const onUploadProgress = call.onUploadProgress;
    const sendBodyLength = onUploadProgress !== undefined || settings.sendContentLength;
    const totalLength = body !== undefined && sendBodyLength ? bodyLength(body) : 0;
    const streamBody = body !== undefined && isStreamBody(body);

    const context = yield* Effect.context<R>();
    const bodyFailure = yield* Ref.make(Option.none<E>());
    const totalLoaded = yield* Ref.make(0);

    const userStream = (stream: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array> =>
      stream.pipe(
        Stream.tapError((error) => Ref.set(bodyFailure, Option.some(error))),
        Stream.provideContext(context),
      ) as Stream.Stream<Uint8Array>;

    const headersFor = (attempt: number): Record<string, string> => ({
      "x-api-blob-request-id": requestId,
      "x-vercel-blob-store-id": auth.storeId,
      "x-api-blob-request-attempt": String(attempt),
      "x-api-version": settings.apiVersion,
      ...(sendBodyLength ? { "x-content-length": String(totalLength) } : {}),
      ...BlobRequestAuth.$match(auth, {
        Bearer: ({ token }) => ({ authorization: `Bearer ${Redacted.value(token)}` }),
        Presigned: () => ({}),
      }),
      ...settings.headers,
      ...(call.json === undefined ? {} : { "content-type": "application/json" }),
      ...call.headers,
    });

    // A streamed body is sent untyped, like the SDK's `ReadableStream` bodies.
    const streamedBody =
      (stream: Stream.Stream<Uint8Array>) => (request: HttpClientRequest.HttpClientRequest) =>
        request.pipe(
          HttpClientRequest.setBody(HttpBody.stream(stream)),
          HttpClientRequest.removeHeader("content-type"),
        );

    const withBody = (
      reporter: UploadProgressReporter | undefined,
    ): Effect.Effect<
      (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
      E
    > =>
      Effect.gen(function* () {
        if (body === undefined) {
          return (request) => request;
        }
        if (!streamsSupported) {
          const bytes = streamBody
            ? (yield* Stream.runCollect(Stream.provideContext(body, context))).reduce(
                concatBytes,
                new Uint8Array(0),
              )
            : undefined;
          yield* Ref.set(totalLoaded, bytes === undefined ? totalLength : bytes.length);
          return HttpClientRequest.setBody(HttpBody.raw(bytes ?? body));
        }
        if (reporter !== undefined) {
          const loaded = yield* Ref.make(0);
          const source = streamBody
            ? userStream(body)
            : (bodyStream(body) as Stream.Stream<Uint8Array>);
          const tracked = source.pipe(
            chunkBytes(progressChunkSize),
            Stream.tap((chunk) =>
              Effect.gen(function* () {
                const sent = yield* Ref.updateAndGet(loaded, (n) => n + chunk.length);
                yield* Ref.set(totalLoaded, sent);
                const total = totalLength !== 0 ? totalLength : sent;
                const percentage = totalLength > 0 ? Number(((sent / total) * 100).toFixed(2)) : 0;
                if (percentage === 100 && totalLength > 0) return;
                yield* reporter.report({ loaded: sent, total, percentage });
              }),
            ),
          );
          return streamedBody(tracked);
        }
        if (streamBody) {
          return streamedBody(userStream(body));
        }
        return HttpClientRequest.setBody(HttpBody.raw(body));
      });

    const failTransport = (error: HttpClientError.HttpClientError) =>
      Effect.flatMap(
        Ref.get(bodyFailure),
        Option.match({
          onNone: () => vercelApiErrorFromHttpClientError(error, { operation }),
          onSome: (failure): Effect.Effect<never, E | VercelApiError> => Effect.fail(failure),
        }),
      );

    const attempts = yield* Ref.make(0);
    const attempt = (reporter: UploadProgressReporter | undefined) =>
      Effect.gen(function* () {
        const index = yield* Ref.getAndUpdate(attempts, (n) => n + 1);
        const setBody = yield* withBody(reporter);
        const request = HttpClientRequest.make(call.method)(url).pipe(
          setBody,
          HttpClientRequest.setHeaders(headersFor(index)),
        );
        const response = yield* client
          .execute(request)
          .pipe(Effect.catchTag("HttpClientError", failTransport));
        if (response.status >= 200 && response.status < 300) {
          return response;
        }
        return yield* blobErrorFromHttpResponse(response, {
          operation,
          locator: call.locator ?? call.path,
          domainErrors: call.domainErrors,
        });
      }).pipe(
        Effect.retry(
          vercelApiTransientRetry({
            maxAttempts: streamBody ? 1 : settings.retries + 1,
            baseDelay: "1 second",
            isRetryable: isRetryableBlobError,
          }),
        ),
      );

    const response =
      onUploadProgress === undefined
        ? yield* attempt(undefined)
        : yield* Effect.gen(function* () {
            yield* onUploadProgress({ loaded: 0, total: totalLength, percentage: 0 });
            const reporter = yield* uploadProgressThrottle(onUploadProgress, call.progressInterval);
            const response = yield* attempt(reporter).pipe(Effect.ensuring(reporter.stop));
            const loaded = yield* Ref.get(totalLoaded);
            yield* onUploadProgress({ loaded, total: loaded, percentage: 100 });
            return response;
          });

    if (call.response === undefined) {
      yield* Effect.ignore(response.arrayBuffer);
      return undefined as A;
    }
    const json = yield* response.json.pipe(
      Effect.mapError((error) => unexpectedResponse(operation, response.status, error.message)),
    );
    return yield* Schema.decodeUnknownEffect(call.response)(json).pipe(
      Effect.mapError((error) =>
        unexpectedResponse(
          operation,
          response.status,
          `Unexpected response body: ${error.message}`,
        ),
      ),
    );
  });

  const fetch = (request: BlobFetchRequest) =>
    client
      .execute(
        HttpClientRequest.get(request.url).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${Redacted.value(request.token)}`,
            ...request.headers,
          }),
        ),
      )
      .pipe(
        Effect.catchTag("HttpClientError", (error) =>
          vercelApiErrorFromHttpClientError(error, { operation: request.operation }),
        ),
        withoutTracePropagation,
      );

  return {
    call: (request) => withoutTracePropagation(call(request)),
    fetch,
  };
};
