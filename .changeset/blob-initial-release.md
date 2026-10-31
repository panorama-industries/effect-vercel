---
"@panorama-industries/effect-vercel-blob": minor
"@panorama-industries/effect-vercel-core": minor
---

Initial release of `effect-vercel-blob`.

Core: `VercelSystemEnv` gains `isVercel`, `branchUrl` and `projectProductionUrl` (implementations of `VercelSystemEnv` must provide them); new `vercelApiErrorFromStatus`; `vercelApiTransientRetry` accepts an `isRetryable` predicate.
