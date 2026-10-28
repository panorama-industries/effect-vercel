# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Adding a Vercel service SDK

Each service is its own package, `packages/<service>` published as
`@panorama-industries/effect-vercel-<service>`.

Check `packages/core` (`@panorama-industries/effect-vercel-core`) before adding anything shared. Reuse it:

- `VercelRegion`, `DeploymentId`, `ProjectId`, `TeamId`, `VercelTarget` (`contracts/vercel-domain.ts`); `VercelSystemEnv` for `VERCEL_*`. Read service-specific variables with `Config` in that package.
- `VercelOidc` for the function OIDC token. Do not depend on `@vercel/oidc`.
- `VercelApiError` with `Api*` reasons for non-domain HTTP failures (401, 403, 400, 413, 429, 5xx, network, unexpected response). Domain errors (e.g. `BlobNotFound`) stay in the service.
- `withVercelApi`, the transient retry schedule, trace-context helpers, and `./testing` (`TestHttpServer`) once implemented.

A need shared by two services goes in core (contract, implementation, tests). Service protocol, such as queue's `multipart/mixed`, stays in that service's `internal/`.

Core names must not collide with a service or `@vercel/sdk`. Prefix generic names (`Api*`, `Vercel*`) and use Vercel's vocabulary (`target` for production, preview, and development).

Official Vercel SDKs are references and test oracles. Pin the ported version as an exact dev dependency and differential-test against it. Do not depend on them at runtime.
