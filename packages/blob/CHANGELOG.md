# @panorama-industries/effect-vercel-blob

## 0.2.0

### Minor Changes

- [#2](https://github.com/panorama-industries/effect-vercel/pull/2) [`8e8b483`](https://github.com/panorama-industries/effect-vercel/commit/8e8b4830a9b4e64d056c0f8e0f0a9452d3c94e95) Thanks [@sgalanb](https://github.com/sgalanb)! - Initial release of `effect-vercel-blob`.

  Core: `VercelSystemEnv` gains `isVercel`, `branchUrl` and `projectProductionUrl` (implementations of `VercelSystemEnv` must provide them); new `vercelApiErrorFromStatus`; `vercelApiTransientRetry` accepts an `isRetryable` predicate.

### Patch Changes

- Updated dependencies [[`8e8b483`](https://github.com/panorama-industries/effect-vercel/commit/8e8b4830a9b4e64d056c0f8e0f0a9452d3c94e95)]:
  - @panorama-industries/effect-vercel-core@0.2.0
