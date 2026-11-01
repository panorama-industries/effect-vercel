---
"@panorama-industries/effect-vercel-blob": minor
---

New `blobLayer(options)` and `blobLayerConfig(options)`: the store, signed URLs and uploads with configuration overrides and the core layers (`VercelOidcLive`, `VercelSystemEnvLive`) already provided, so only an `HttpClient` is left. `blobLayerConfig` takes `Config.Wrap` options, e.g. `{ token: Config.Redacted("MY_TOKEN") }`. `BlobLive` is now `blobLayer()`.
