# @panorama-industries/effect-vercel-blob

## 0.3.0

### Minor Changes

- [#4](https://github.com/panorama-industries/effect-vercel/pull/4) [`d63e0ea`](https://github.com/panorama-industries/effect-vercel/commit/d63e0ea275077edc86325a72d3c9fb6693927a3f) Thanks [@sgalanb](https://github.com/sgalanb)! - New `blobLayer(options)` and `blobLayerConfig(options)`: the store, signed URLs and uploads with configuration overrides and the core layers (`VercelOidcLive`, `VercelSystemEnvLive`) already provided, so only an `HttpClient` is left. `blobLayerConfig` takes `Config.Wrap` options, e.g. `{ token: Config.Redacted("MY_TOKEN") }`. `BlobLive` is now `blobLayer()`.

### Patch Changes

- Updated dependencies []:
  - @panorama-industries/effect-vercel-core@0.3.0

## 0.2.0

### Minor Changes

- [#2](https://github.com/panorama-industries/effect-vercel/pull/2) [`8e8b483`](https://github.com/panorama-industries/effect-vercel/commit/8e8b4830a9b4e64d056c0f8e0f0a9452d3c94e95) Thanks [@sgalanb](https://github.com/sgalanb)! - Initial release of `effect-vercel-blob`.

  Core: `VercelSystemEnv` gains `isVercel`, `branchUrl` and `projectProductionUrl` (implementations of `VercelSystemEnv` must provide them); new `vercelApiErrorFromStatus`; `vercelApiTransientRetry` accepts an `isRetryable` predicate.

### Patch Changes

- Updated dependencies [[`8e8b483`](https://github.com/panorama-industries/effect-vercel/commit/8e8b4830a9b4e64d056c0f8e0f0a9452d3c94e95)]:
  - @panorama-industries/effect-vercel-core@0.2.0
