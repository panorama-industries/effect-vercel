## Effect Service Modules

### Contracts and Implementations

Each package splits its Effect services into two folders under `src/`:

- `contracts/`: one file per capability, named for it (`queue-api.ts`). It holds the contextual
  service class plus the schemas, branded types, and tagged errors that appear in its interface.
  Contracts declare _what_ a service does and import no implementation code.
- `implementation/`: one file per contract, with the same name plus a `-live` suffix
  (`queue-api-live.ts`). It exports the Layer that implements the contract, named
  `<CapabilityName>Live`.

```text
packages/queue/src/
  contracts/
    queue-api.ts           # QueueApi service, its schemas and errors
    queue-producer.ts
  implementation/
    queue-api-live.ts      # QueueApiLive
    queue-api-live.test.ts
    queue-producer-live.ts
  index.ts
```

Declare the service shape inline on the `Context.Service` class; do not export a separate `I<Name>`
interface. Use the key `@effect-vercel/<package>/<CapabilityName>`.

```ts
// contracts/queue-api.ts
/** Sends and receives messages through Vercel Queues. */
export class QueueApi extends Context.Service<
  QueueApi,
  {
    readonly send: (
      topic: TopicName,
      payload: unknown,
    ) => Effect.Effect<MessageId, QueueSendFailed>;
  }
>()("@effect-vercel/queue/QueueApi") {}
```

Dependencies are yielded inside the Layer and stay in its requirements, so callers and
composition roots provide them with `Layer.provide`.

```ts
// implementation/queue-api-live.ts
/** Implements QueueApi over HTTP; requires an HttpClient. */
export const QueueApiLive = Layer.effect(
  QueueApi,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const send = Effect.fn("QueueApi.send")(function* (topic: TopicName, payload: unknown) {
      // ...
    });

    return QueueApi.of({ send });
  }),
);
```

A contextual service name does not have to end in `Service`. Use the shortest natural name for the
stable capability, and do not use `Tag` in symbol names.

Code that uses a service imports it from `contracts/` and yields it. Only composition roots, the
package entry point, and tests import from `implementation/`. Tests build the Layer graph they need
by providing `<CapabilityName>Live` with test dependencies, or provide a test implementation of the
contract that crosses the same service interface with behaviorally honest behavior. Do not add
partial mocks or weaken production behavior to make tests convenient.

## Comments and JSDoc

Every exported JavaScript or TypeScript symbol has JSDoc at its original declaration. A concise comment is sufficient when it states the sharpest caller-visible fact the signature cannot show. Use additional prose or tags only for further constraints, expected failures, side effects, ownership, invariants, trade-offs, non-obvious domain rules, or safety justifications.

Names, public documentation, UI copy, and rendered errors use durable vocabulary appropriate to their audience. Use ordinary domain phrases readers are likely to search for when those phrases differ from an identifier's spelling. Keep ticket names, migration phases, internal storage fields, framework mechanics, and planning language in internal implementation or planning material.

Public methods and properties of an exported class also require JSDoc. Document private/internal code when safe maintenance depends on a non-obvious purpose, invariant, domain rule, side effect, trade-off, or safety justification.

Document each original declaration once; re-exports rely on that documentation. Write explicit documentation in place of inheritance tags such as `@inheritDoc`.

Attach `/** ... */` JSDoc directly to its declaration. Include tags when they add caller-relevant information:

```ts
/**
 * Parse and validate an email address at an external input boundary.
 *
 * @param input - Raw input received from outside the application.
 * @returns A validated email address, or `InvalidEmailAddress` when validation fails.
 */
export function parseEmailAddress(input: string): Result<EmailAddress, InvalidEmailAddress>;
```

Add `@template` when a type parameter has a role or constraint the signature does not make clear:

```ts
/**
 * Map the success value of a result while preserving its error channel.
 *
 * @template E - Error channel preserved without invoking `fn`.
 * @param fn - Transforms the success value; it is skipped when `result` contains an error.
 * @returns A result containing the transformed success value or the original error.
 */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E>;
```

Reserve `@throws` for unrecoverable defects, framework-required behavior, and temporary `notYetImplemented` paths. Describe expected typed errors in `@returns` or the operation's documented outcomes.

Document exported object fields whose semantics extend beyond their names and types:

```ts
/** Options that bound and identify an outbound request. */
export type RequestOptions = {
  /** Total request budget, including connection setup and retries. */
  readonly timeout: Duration;

  /** Correlation identifier forwarded unchanged to downstream services. */
  readonly correlationId: CorrelationId;
};
```
