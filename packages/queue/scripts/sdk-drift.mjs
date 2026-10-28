#!/usr/bin/env node
/**
 * Show how the `@vercel/queue` source changed between the pinned version (the `@vercel/queue`
 * devDependency installed in this package) and another published version.
 *
 * The SDK publishes its original TypeScript in `dist/index.js.map` (`sourcesContent`). This script
 * downloads the other version's tarball from the npm registry, extracts both source trees into a
 * temporary directory and prints a unified diff of the SDK's own files (`src/`, not bundled
 * dependencies).
 *
 * Usage, from the repository root:
 *
 *   node packages/queue/scripts/sdk-drift.mjs <version> [--keep]
 *
 *   node packages/queue/scripts/sdk-drift.mjs 0.11.0          # diff 0.10.0 (pinned) → 0.11.0
 *   node packages/queue/scripts/sdk-drift.mjs latest --keep   # keep the extracted trees
 *
 * Exits 0 when the sources are identical, 1 when they differ and 2 on errors. Review the diff for
 * changes to `api-client.ts`, `multipart.ts`, `types.ts` and `callback.ts` before bumping the pin
 * and the differential suite in `test/differential/`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const target = args.find((arg) => !arg.startsWith("--"));

if (target === undefined) {
  console.error("Usage: node packages/queue/scripts/sdk-drift.mjs <version|tag> [--keep]");
  process.exit(2);
}

const require = createRequire(join(packageRoot, "package.json"));
const pinnedRoot = dirname(dirname(require.resolve("@vercel/queue")));
const pinnedVersion = JSON.parse(readFileSync(join(pinnedRoot, "package.json"), "utf8")).version;

const work = mkdtempSync(join(tmpdir(), "vercel-queue-drift-"));

const fail = (message) => {
  console.error(message);
  if (!keep) rmSync(work, { recursive: true, force: true });
  process.exit(2);
};

const writeSources = (mapText, outDir) => {
  const map = JSON.parse(mapText);
  let written = 0;
  map.sources.forEach((source, index) => {
    const content = map.sourcesContent?.[index];
    const path = normalize(source.replace(/^webpack:\/\//, "").replace(/^(\.\.\/)+/, ""));
    if (content == null || path.includes("node_modules") || path.startsWith("..")) return;
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    written += 1;
  });
  if (written === 0) fail(`No sources found in the source map for ${outDir}`);
};

const metadata = await fetch(
  `https://registry.npmjs.org/@vercel%2Fqueue/${encodeURIComponent(target)}`,
);
if (!metadata.ok) fail(`Cannot resolve @vercel/queue@${target}: HTTP ${metadata.status}`);
const { version, dist } = await metadata.json();

const tarball = await fetch(dist.tarball);
if (!tarball.ok) fail(`Cannot download ${dist.tarball}: HTTP ${tarball.status}`);
const archive = join(work, "package.tgz");
writeFileSync(archive, new Uint8Array(await tarball.arrayBuffer()));
const extracted = join(work, "extracted");
mkdirSync(extracted);
const untar = spawnSync("tar", ["-xzf", archive, "-C", extracted, "package/dist/index.js.map"]);
if (untar.status !== 0) fail(`Cannot extract dist/index.js.map: ${String(untar.stderr)}`);

const before = join(work, pinnedVersion);
const after = join(work, version);
writeSources(readFileSync(join(pinnedRoot, "dist/index.js.map"), "utf8"), before);
writeSources(readFileSync(join(extracted, "package/dist/index.js.map"), "utf8"), after);

console.error(`@vercel/queue ${pinnedVersion} (pinned) → ${version}`);
const diff = spawnSync("diff", ["-ru", pinnedVersion, version], { cwd: work, stdio: "inherit" });

if (keep) console.error(`Sources kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(diff.status ?? 2);
