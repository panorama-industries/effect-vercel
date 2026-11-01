# @panorama-industries/effect-vercel-blob

Effect-native client for [Vercel Blob](https://vercel.com/docs/vercel-blob): uploads, downloads,
listing, multipart, signed URLs and browser uploads. Part of
[effect-vercel](https://github.com/panorama-industries/effect-vercel).

```bash
pnpm add @panorama-industries/effect-vercel-blob effect
```

## Requirements

- `effect` `^4.0.6` (peer dependency)
- ESM only

## Usage

`blobLayer` provides `BlobStore`, `BlobSignedUrls` and `BlobUploads`, including the Vercel OIDC and
system environment layers from core; only an `HttpClient` is left to provide.

```ts
import { BlobStore, blobLayer, BlobLive } from "@panorama-industries/effect-vercel-blob";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

// From the environment: BLOB_READ_WRITE_TOKEN, or Vercel OIDC with BLOB_STORE_ID.
const Blob = BlobLive.pipe(Layer.provide(FetchHttpClient.layer));

// Or with explicit values, which take precedence over the environment.
const BlobWithToken = blobLayer({ token: "vercel_blob_rw_…" }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

const program = Effect.gen(function* () {
  const blob = yield* BlobStore;
  return yield* blob.list();
}).pipe(Effect.provide(Blob));
```

`blobLayerConfig` reads the same options from `Config`, e.g.
`blobLayerConfig({ token: Config.Redacted("MY_BLOB_TOKEN") })`. To build options from another
service, wrap `blobLayer` in `Layer.unwrap`.
