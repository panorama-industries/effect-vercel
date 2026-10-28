# Design: `effect-vercel-core` and `effect-vercel-queue`

Status: draft for review. Reference implementations: `@vercel/queue@0.10.0` (source embedded in its
source maps) and `@vercel/oidc` (cloned in
`../effect-vercel-reference-repos/vercel/packages/oidc`). Target runtime: `effect@4.x`.

Packages publish as `@panorama-industries/effect-vercel-<service>`. Below, "core" and "queue" are
short for `@panorama-industries/effect-vercel-core` and `@panorama-industries/effect-vercel-queue`.

## Goals

- Effect-native client for Vercel Queues with feature parity for production push and poll consumers.
- `@vercel/queue` is a spec and test oracle, never a runtime dependency.
- Everything that the next services (Blob, Edge Config, Workflow, Sandbox, Runtime Cache, AI
  Gateway, REST API) will repeat lives in core.
- No Vercel runtime dependencies: OIDC is reimplemented in core.

Porting rule: reimplement exactly what the official SDKs execute at runtime so behavior matches them, and nothing more; whole support packages (`@vercel/cli-config`, `@vercel/cli-exec`) are ported only as far as an SDK calls into them.

Non-goals for v1: the SDK's legacy in-process dev mode, `StreamTransport` payloads, Node
`IncomingMessage` adapters (users go through `HttpEffect` or Web `Request`), and a Vercel Function
handler wrapper: `HttpEffect.toWebHandlerLayer` already builds the layer once per instance, so a
`VercelFunction` module waits until there is a `waitUntil` bridge to put in it.

## Repository layout

```text
packages/
  core/    @panorama-industries/effect-vercel-core
  queue/   @panorama-industries/effect-vercel-queue   (depends on core via workspace:^)
```

Each package: ESM only, `sideEffects: false`, `exports` map with `.` and `./testing`, follows
`docs/coding-standards.md` (`contracts/` + `implementation/`).

Dependencies: `effect` is a **peer** dependency everywhere (and a dev dependency for the
workspace), never a regular dependency, so users get one Effect runtime and one set of
`Context`/`Layer` identities. In Effect 4, `HttpClient`, `HttpServerRequest`, `FileSystem` and
`Path` live in `effect` itself, so there is no `@effect/platform` to depend on; Node
implementations (`@effect/platform-node`) are supplied by the user only for layers that need them.
Core is a regular dependency of each service package, so users install one package per service.
Service keys are strings, so two copies of core in a tree still resolve the same services; Changesets
keeps the `workspace:^` ranges aligned so that rarely happens.

Tooling: pnpm workspaces, Changesets for independent versions and changelogs, published from CI
with npm provenance. Build and tsconfig layout borrowed from the Effect monorepo (`tsconfig.base`,
per-package `tsconfig.src`/`tsconfig.test`, `tsc -b` emit to `dist/`, `@effect/vitest`).

## Core

What every Vercel service client needs.

| Module                  | Contract                                                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel-system-env`     | `VercelSystemEnv` service, `VercelSystemEnvLive` (from `Config`)                       | Typed view of `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_ID`, `NODE_ENV`, `VERCEL_CLI_VERSION`. Tests provide it with `ConfigProvider.fromUnknown`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `domain`                | schemas only                                                                           | Branded `VercelRegion` (known list + open string), `DeploymentId`, `ProjectId`, `TeamId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `vercel-oidc`           | `VercelOidc` service: `token: Effect<OidcToken, OidcTokenUnavailable>`                 | Reimplementation of `@vercel/oidc`. `VercelOidcLive`: `x-vercel-oidc-token` from the `Symbol.for("@vercel/request-context")` global, else `VERCEL_OIDC_TOKEN`; no file system, safe on Edge. `VercelOidcRefreshingLive`: adds the dev path (expiry check, CLI auth file, OAuth refresh, token exchange, cache in the CLI data dir); requires `FileSystem`, `Path`, `HttpClient`, `ChildProcessSpawner`. Ports only the slices of `@vercel/cli-config` (data-dir lookup in the same order: XDG `com.vercel.cli`, `~/.now`, XDG `now`; `auth.json` read/write; keyring detection) and `@vercel/cli-exec` (`vercel project token <id> --format=json [--scope team]` for keyring credentials, run from `PATH`) that OIDC calls, with the same behavior. `VercelOidc.static(token)` for explicit tokens and tests. Token verification (`jose`) is out of scope for v1. |
| `vercel-access-token`   | later                                                                                  | `VERCEL_TOKEN` + `teamId` for REST-API services.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `api-client`            | `withVercelApi(options)` client combinator (not a service; `make*` imports are linted) | Builds a configured `HttpClient`: base URL, bearer auth from a token effect, `User-Agent: @panorama-industries/effect-vercel-<pkg>/<version>`, status-to-error mapping, transient retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `api-errors`            | `VercelApiError` with tagged `reason`                                                  | `ApiUnauthorized`, `ApiForbidden`, `ApiBadRequest{message}`, `ApiPayloadTooLarge`, `ApiRateLimited{retryAfter: Option<Duration>}`, `ApiServerError{status}`, `ApiNetworkFailure{cause}`, `ApiUnexpectedResponse{status}`; plus `operation` and `errorCode` fields. Callers use `Effect.catchReason`. Services add their own domain errors on top.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `retry`                 | `transientRetry` `Schedule`                                                            | Retries `ApiNetworkFailure` and `ApiRateLimited` (delay from `Headers.parseRetryAfter`); nothing else. Max attempts configurable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `trace-context`         | `TraceContext.inject` / `TraceContext.linkFrom(headers)`                               | Thin wrapper over `HttpTraceContext.w3c`/`toHeaders` from `effect/http`: `linkFrom` reads a custom header (`x-vercel-queue-traceparent`) into an Effect `SpanLink`. `HttpClient` already propagates `traceparent`; Effect does not carry `tracestate`/`baggage`, so they are passed through unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `testing` (`./testing`) | `TestHttpServer`, `HttpRecorder`                                                       | A real local HTTP server with scripted responses and a request log; used by every package's unit and differential tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Queue

### Domain (`contracts/queue-domain.ts`)

Branded: `TopicName` (`[A-Za-z0-9_-]+`), `ConsumerGroupName`, `MessageId`, `ReceiptHandle`,
`IdempotencyKey`, `ConcurrencyKey`.

`Topic<A, I>`: a value pairing a name with a payload codec, shared by producers and consumers.

```ts
export const Orders = Topic.json("orders", Order); // Schema.Codec<Order, OrderEncoded>
export const Thumbnails = Topic.bytes("thumbnails"); // Uint8Array, application/octet-stream

type OrderPayload = Topic.Type<typeof Orders>; // Order
type OrderWire = Topic.Encoded<typeof Orders>; // OrderEncoded
```

`Topic.Type` and `Topic.Encoded` mirror `Schema.Type` and `Schema.Encoded`; producer, consumer and
poller signatures use them instead of restating the codec's types.

`MessageMetadata`: `messageId`, `deliveryCount`, `createdAt`/`expiresAt` (`DateTime.Utc`),
`topic`, `consumerGroup`, `region`, plus experimental `handoffCount` and `coalesced`.

`MessageHandle`: `{ topic, consumerGroup, messageId, receiptHandle, region }`. Every follow-up call
(ack, visibility) takes a handle and routes to `handle.region`, which replaces the SDK's
`withRegion` client copies.

### Errors

Shared: `VercelApiError` from core. Queue-specific tagged errors:
`MessageNotFound`, `MessageNotAvailable` (reasons `MessageLocked{retryAfter}`, `ConcurrencyCoalescedPending{coalescedCount}`, `MessageUnavailable`),
`MessageAlreadyProcessed`, `MessageCorrupted`, `ConsumerDiscoveryFailed`,
`ConsumerRegistryNotConfigured`, `PayloadEncodeFailed`, `PayloadDecodeFailed`.
An empty queue is `[]`, not an error. Receive limits are a branded `ReceiveLimit` (1–10), so invalid limits fail where they are constructed.

### `QueueConfig` (`contracts/queue-config.ts`)

`{ region, baseUrl: (region) => URL, auth: Oidc | Token(redacted), deploymentId: Option, pinSends: boolean, headers }`. As in the SDK, consumer calls carry the deployment ID whenever one is known; `pinSends` only controls sends.

`QueueConfigLive` derives it from `VercelSystemEnv`:
region from `VERCEL_REGION` (fallback `iad1`, logged once); local broker when
`NODE_ENV=development`, `VERCEL_CLI_VERSION >= 59.26.0` and `VERCEL_QUEUE_BASE_URL` is set (token
from `VERCEL_QUEUE_TOKEN`, no deployment pinning); otherwise `https://{region}.vercel-queue.com`
with OIDC and pinning to `VERCEL_DEPLOYMENT_ID`. Missing deployment ID outside dev is a config
error at layer build, not at first send. `QueueConfig.layer(options)` overrides any field.

### `QueueApi` (`contracts/queue-api.ts`): low-level REST, 1:1 with the wire protocol

| Method                                                                                      | HTTP                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `send(topic, body, options)` → `MessageId \| Deferred`                                      | `POST /api/v3/topic/{t}`                          |
| `sendBatch(topic, entries)` → `BatchResult[]` (≤100)                                        | `POST /api/v3/topic/{t}/batch`, `multipart/mixed` |
| `receive(topic, group, { limit, visibilityTimeout, cursorFallback })` → `ReceivedMessage[]` | `POST .../consumer/{g}` (204 = empty)             |
| `receiveById(topic, group, id, { visibilityTimeout })` → `ReceivedMessage`                  | `POST .../consumer/{g}/id/{id}`                   |
| `acknowledge(handle, { ifCoalesced? })`                                                     | `DELETE .../consumer/{g}/lease/{receiptHandle}`   |
| `changeVisibility(handle, timeout, { handoff? })` → `HandoffOutcome?`                       | `PATCH ...`                                       |

Bodies are `Uint8Array` here; codecs live one layer up. Headers (`Vqs-*`), status mapping, and
`Vqs-Error-Code` handling match the SDK exactly. Ack and visibility retry up to 3 times on
`ApiNetworkFailure`/`ApiRateLimited` only. Multipart encoding (batch send) and parsing (receive) live in queue's own `internal/`: Effect's `Multipart` handles only `multipart/form-data`. `QueueApiLive` requires `HttpClient`, `QueueConfig`, `VercelOidc`.

### `QueueProducer` (`contracts/queue-producer.ts`)

```ts
send: <A, I>(topic: Topic<A, I>, payload: A, options?: SendOptions) => Effect<SendResult, ...>
sendBatch: <A, I>(topic: Topic<A, I>, entries: NonEmptyReadonlyArray<BatchEntry<A>>) => Effect<ReadonlyArray<BatchResult>, ...>
```

`SendOptions`: `idempotencyKey`, `retention: Duration`, `delay: Duration`, `headers`,
`experimentalConcurrencyKey`. Span `vqs.send` (kind `producer`) with trace headers injected.
Encodes with the topic codec; 413 surfaces as `VercelApiError` reason `ApiPayloadTooLarge`.

### Consuming

One internal pipeline, used by both push and poll:

1. Acquire the lease as a scoped resource; fork a renewal fiber with `forkScoped`
   (`every min(60, max(10, timeout/5))s`, first tick from the visibility deadline, 3 s retry on
   transient failure, stop on 4xx).
2. Decode the payload with the topic codec (`PayloadDecodeFailed` goes to the error policy).
3. Run the user handler in span `vqs.process` (kind `consumer`), linked to
   `x-vercel-queue-traceparent`.
4. Map the outcome to a `RetryDirective` and apply it: ack, `changeVisibility`, handoff, or fail.

```ts
type RetryDirective = Data.TaggedEnum<{
  Acknowledge: {};
  RetryAfter: { delay: Duration };
  ExperimentalHandoff: {};
  Fail: {}; // queue's own redelivery: push answers 500; poll returns the handler error, lease expires
}>;

interface ConsumeOptions<E> {
  visibilityTimeout?: Duration; // default 5 minutes
  onError?: (
    error: E | PayloadDecodeFailed | ConcurrencyCoalescedPending,
    meta: MessageMetadata,
  ) => Effect<RetryDirective, never, R2>;
  experimentalMaxCoalescedReruns?: number;
}

RetryDirective.fromSchedule(schedule); // deliveryCount-driven delay, Acknowledge when exhausted
```

Defects are never swallowed: they map to `Fail`.

#### `QueueConsumer` (push, `contracts/queue-consumer.ts`)

```ts
handler: <A, I, E, R>(
  topic: Topic<A, I>,
  handle: (payload: A, meta: MessageMetadata) => Effect<void, E, R>,
  options?: ConsumeOptions<E>,
) => Effect<HttpServerResponse, never, HttpServerRequest | R>;
```

Parses v1beta (structured, then `receiveById`) and v2beta (binary; body inline when a receipt
handle is present, else `receiveById`). Responses: 200 `success`; 200 `skipped` for 409/410;
400 for malformed CloudEvents; 500 otherwise. Usage on Vercel, with `HttpEffect` from
`effect/http`:

```ts
export const POST = HttpEffect.toWebHandlerLayer(
  QueueConsumer.use((consumer) => consumer.handler(Orders, fulfil)),
  AppLayer,
).handler;
```

#### `QueuePoller` (poll, `contracts/queue-poller.ts`)

```ts
receive: <A, I, E, R>(topic, group, handle, options & { limit?, cursorFallback? })
  => Effect<ReceiveOutcome, E | QueueRequestError | MessageCorrupted, R | R2>
receiveById: (...) => Effect<ReceiveOutcome, ...>
```

`ReceiveOutcome`: `Processed{count}` | `Empty` | `NotFound` | `NotAvailable` | `AlreadyProcessed`.
A `Stream` variant can come later on the same pipeline.

### Experimental surface

Concurrency keys, coalesced reruns and handoff ship in v1, every name prefixed `experimental`
(`experimentalConcurrencyKey`, `experimentalMaxCoalescedReruns`, `RetryDirective.ExperimentalHandoff`,
`MessageMetadata.experimentalCoalesced`). They may change in a minor release; the README says so.

### Layers exposed from `index.ts`

`QueueLive = QueueProducerLive + QueueConsumerLive + QueuePollerLive`, provided with
`QueueApiLive`, `QueueConfigLive`, `VercelSystemEnvLive`, `VercelOidcLive`. The user supplies
`FetchHttpClient.layer` (and Node platform layers if they swap in `VercelOidcRefreshingLive`).

## Testing

- Unit: each `*Live` layer against `TestHttpServer` from `@panorama-industries/effect-vercel-core/testing`.
- Differential: `@vercel/queue@0.10.0` pinned as an exact dev dependency. Both clients run the same
  operations against the same recording server; assert identical method, path, `Vqs-*` headers and
  body, and identical outcomes for each scripted status (200/204/400/401/403/404/409/410/413/429/5xx).
- Drift check script: extracts `sourcesContent` from a new SDK version and diffs it against the
  pinned one.

## Build order

1. Contracts for core and queue, workspace tooling (tsconfig, vitest, build, changesets). One pass,
   reviewed before fan-out.
2. In parallel, against contracts only:
   - core implementations (incl. OIDC port with its tests) and `./testing`
   - `QueueApiLive` (incl. multipart batch send and multipart receive parsing)
   - consume pipeline, `QueueConsumerLive`, `QueuePollerLive` (tested with a test `QueueApi`)
   - `QueueProducerLive` and the differential test harness
3. Integration, README, changeset, `npm publish --dry-run`.
