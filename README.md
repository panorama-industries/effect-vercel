# effect-vercel

Effect-native SDKs for Vercel services.

## Packages

| Name                                                         | Description                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [`@panorama-industries/effect-vercel-core`](packages/core)   | Shared building blocks: environment, OIDC credentials, API client, errors and test utilities. |
| [`@panorama-industries/effect-vercel-queue`](packages/queue) | Client for Vercel Queues: typed topics, producers, push and poll consumers.                   |
| [`@panorama-industries/effect-vercel-blob`](packages/blob)   | Client for Vercel Blob: uploads, downloads, multipart, signed URLs and browser uploads.       |

## Requirements

All packages:

- `effect` `^4.0.6` (peer dependency)
- ESM only

### `effect-vercel-queue`

- Vercel CLI `59.26.0` or above.

## Releasing

Packages are versioned together with [Changesets](https://github.com/changesets/changesets) and
published from GitHub Actions with npm trusted publishing.

1. In a PR that changes a published package, run `pnpm changeset`, pick the bump (in `0.x`, `minor`

   for breaking changes and `patch` for everything else) and describe the change.

2. Merging to `main` opens or updates the **Version Packages** PR, which bumps versions and writes

   each package's `CHANGELOG.md`.

3. Merging the Version Packages PR publishes to npm, tags the release and creates GitHub releases.

A new package must exist on npm before trusted publishing can be configured for it. Before its
first release, run this once from your machine; it publishes a `0.0.0` placeholder and trusts the
Release workflow, with no tokens to create or store:

```bash
pnpm bootstrap:npm
```

It runs `npm login` if you are not logged in.

The Release workflow fails before publishing anything while a package is missing from npm.

To try unreleased changes, run the **Release** workflow manually on a branch with changesets. It
publishes `x.y.z-snapshot-<datetime>` under the `snapshot` dist-tag:

```bash
pnpm add @panorama-industries/effect-vercel-queue@snapshot
```
