## Effect Service Modules

### Service Constructor Locality

Do not pass dependency-bearing constructor functions through application code or import them into
runtime composition modules. In an Effect project, an exported free function named
`make<CapabilityName>` is reserved for constructing the contextual service declared in the same
capability module.

The owning service module may use its constructor to define dependency-preserving and ready Layers.
All non-test consumers import those Layers, yield the contextual service, and allow requirements to
propagate to the composition root. They must not import or invoke the constructor directly. Only
files matching the repository's test conventions (`*.test.*` and `*.spec.*`) may import an exported
service constructor, and only when focused verification genuinely needs to exercise construction
without the ready Layer.

```ts
// issue-service.ts
export const makeIssueService = Effect.gen(function* () {
  const issueStore = yield* IssueStore;
  return IssueService.of({/* operations */});
});

export const issueServiceLayerWithoutDependencies = Layer.effect(IssueService, makeIssueService);

// Runtime modules import the Layer and yield IssueService. They never import makeIssueService.
```

Do not introduce exported `make<X>` functions for dependency bundles, runtime registries, test
harness capabilities, or alternate manual dependency injection. Model them as contextual services
with Layers when they own capabilities or runtime state; keep genuinely pure construction local to
its owning module or expose a domain-named operation that describes the value being derived rather
than a generic constructor seam.

Enforce this with a project lint rule that rejects project-local imports whose imported name matches
`make[A-Z]` unless the importing file matches `*.test.*` or `*.spec.*`. The diagnostic should direct
runtime callers to import the owning Layer and yield the contextual service. Library imports and
schema-owned static constructors such as `AccountName.make` are outside this rule.

Put each new Effect service in a file named for its capability. Keep the service declaration and
its construction in this order:

1. The service shape interface.
2. The contextual service class.
3. The service constructor.
4. The Layer that preserves dependency requirements.
5. The ready production Layer that provides production dependencies.
6. The ready test Layer that provides behaviorally faithful test dependencies.

Every exported symbol must include the capability name rather than relying on its file path for
context. Do not use `Tag` in symbol names. Name constructors `make<CapabilityName>` and use camel
case for Layer values.

A contextual service name does not have to end in `Service`. Use the shortest natural name for the
stable capability. `IssueService` is a sensible default when `Service` honestly describes a broad,
cohesive capability; a more specific established name such as `IssueStore` is preferable when it
better describes the authority. Apply the same chosen capability name consistently to its interface,
constructor, and Layers—for example, `IIssueStore`, `makeIssueStore`, `issueStoreLayer`, and
`issueStoreTestLayer`.

```ts
/** Defines the Issue service capability exposed to application callers. */
export interface IIssueService {
  readonly findIssue: (id: IssueId) => Effect.Effect<Issue, IssueNotFound>;
}

/** Provides the contextual Issue service capability. */
export class IssueService extends Context.Service<IssueService, IIssueService>()(
  "@app/IssueService",
) {}

/** Constructs the Issue service while preserving its dependency requirements. */
export const makeIssueService = Effect.gen(function* () {
  const issueStore = yield* IssueStore;

  return IssueService.of({
    findIssue: Effect.fn("IssueService.findIssue")(function* (id: IssueId) {
      return yield* issueStore.findIssue(id);
    }),
  });
});

/** Provides the Issue service without selecting dependency implementations. */
export const issueServiceLayerWithoutDependencies = Layer.effect(IssueService, makeIssueService);

/** Provides the Issue service with its production dependencies. */
export const issueServiceLayer = issueServiceLayerWithoutDependencies.pipe(
  Layer.provide(issueStoreLayer),
);

/** Provides the Issue service with behaviorally faithful test dependencies. */
export const issueServiceTestLayer = issueServiceLayerWithoutDependencies.pipe(
  Layer.provide(issueStoreTestLayer),
);
```

`<capabilityName>LayerWithoutDependencies` does not mean that the service has no dependencies. It
means the Layer leaves those requirements visible so callers or composition roots can provide
them. `<capabilityName>Layer` selects the complete production dependency graph. If the service has
no production dependencies, still export both canonical names and let the production Layer
reference the dependency-preserving Layer.

A `<capabilityName>TestLayer` must cross the same service interface as production and use complete,
behaviorally honest test implementations. Do not add partial mocks or weaken production behavior
solely to make the test Layer convenient.

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
