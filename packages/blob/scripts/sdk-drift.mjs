#!/usr/bin/env node
/**
 * Show how the `@vercel/blob` source changed between the pinned version (the `@vercel/blob`
 * devDependency installed in this package) and another published version.
 *
 * The published tarball ships no TypeScript sources, but every bundle in `dist/` has a source map
 * whose `sourcesContent` embeds the original `src/*.ts` files (`index.js.map`, `client.js.map` and
 * the shared `chunk-<hash>.js.map`, plus `.cjs.map` twins of the same sources). This script
 * downloads the other version's tarball from the npm registry, rebuilds both source trees from the
 * ESM source maps into a temporary directory, and prints a unified diff of the SDK's own files
 * (`src/`, not bundled dependencies). Diffing the bundled `dist/*.js` instead would be noisy:
 * chunk names are content hashes and esbuild renames locals between builds.
 *
 * If a future version stops shipping `sourcesContent`, the script fails (exit 2) instead of
 * printing an empty diff; diff `dist/*.js` by hand in that case (run with `--keep`).
 *
 * Usage, from the repository root:
 *
 *   node packages/blob/scripts/sdk-drift.mjs <version> [--keep]
 *
 *   node packages/blob/scripts/sdk-drift.mjs 2.9.0          # diff 2.8.2 (pinned) → 2.9.0
 *   node packages/blob/scripts/sdk-drift.mjs latest --keep  # keep the extracted trees
 *
 * Exits 0 when the sources are identical, 1 when they differ and 2 on errors. Review the diff for
 * changes to `api.ts` (error codes, retries, headers), `helpers.ts` (auth, URLs), `put-helpers.ts`,
 * `multipart/`, `signed-token.ts`, `presign-query-params.ts` and `client.ts` (client tokens,
 * callbacks) before bumping the pin and the differential suite in `test/differential/`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const target = args.find((arg) => !arg.startsWith("--"));

if (target === undefined) {
  console.error("Usage: node packages/blob/scripts/sdk-drift.mjs <version|tag> [--keep]");
  process.exit(2);
}

const require = createRequire(join(packageRoot, "package.json"));
// `@vercel/blob` does not export `./package.json`; its `require` entry is `dist/index.cjs`.
const pinnedRoot = dirname(dirname(require.resolve("@vercel/blob")));
const pinnedVersion = JSON.parse(readFileSync(join(pinnedRoot, "package.json"), "utf8")).version;

const work = mkdtempSync(join(tmpdir(), "vercel-blob-drift-"));

const fail = (message) => {
  console.error(message);
  if (!keep) rmSync(work, { recursive: true, force: true });
  process.exit(2);
};

/** Write every original source embedded in the ESM source maps of `distDir` under `outDir`. */
const writeSources = (distDir, outDir) => {
  const maps = readdirSync(distDir).filter((file) => file.endsWith(".js.map"));
  let written = 0;
  for (const file of maps) {
    const map = JSON.parse(readFileSync(join(distDir, file), "utf8"));
    map.sources.forEach((source, index) => {
      const content = map.sourcesContent?.[index];
      const path = normalize(source.replace(/^webpack:\/\//, "").replace(/^(\.\.\/)+/, ""));
      if (content == null || path.includes("node_modules") || path.startsWith("..")) return;
      const out = join(outDir, path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, content);
      written += 1;
    });
  }
  if (written === 0) fail(`No sourcesContent found in the source maps of ${distDir}`);
};

const metadata = await fetch(
  `https://registry.npmjs.org/@vercel%2Fblob/${encodeURIComponent(target)}`,
);
if (!metadata.ok) fail(`Cannot resolve @vercel/blob@${target}: HTTP ${metadata.status}`);
const { version, dist } = await metadata.json();

const tarball = await fetch(dist.tarball);
if (!tarball.ok) fail(`Cannot download ${dist.tarball}: HTTP ${tarball.status}`);
const archive = join(work, "package.tgz");
writeFileSync(archive, new Uint8Array(await tarball.arrayBuffer()));
const extracted = join(work, "extracted");
mkdirSync(extracted);
const untar = spawnSync("tar", ["-xzf", archive, "-C", extracted, "package/dist"]);
if (untar.status !== 0) fail(`Cannot extract dist/: ${String(untar.stderr)}`);

const before = join(work, pinnedVersion);
const after = join(work, version);
writeSources(join(pinnedRoot, "dist"), before);
writeSources(join(extracted, "package/dist"), after);

console.error(`@vercel/blob ${pinnedVersion} (pinned) → ${version}`);
const diff = spawnSync("diff", ["-ru", pinnedVersion, version], { cwd: work, stdio: "inherit" });

if (keep) console.error(`Sources kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(diff.status ?? 2);
