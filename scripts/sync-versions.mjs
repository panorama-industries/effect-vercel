#!/usr/bin/env node
/**
 * Copy each package's `package.json` version into its `src/internal/version.ts`, when it has one.
 *
 * `changeset version` only rewrites `package.json`, so the `packageVersion` constant used in the
 * `User-Agent` header would drift. The root `version` and `snapshot` scripts run this right after
 * Changesets bumps the versions.
 *
 * Usage, from the repository root:
 *
 *   node scripts/sync-versions.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages");
const versionPattern = /export const packageVersion = "[^"]*";/;

for (const name of readdirSync(packagesDir)) {
  const versionFile = join(packagesDir, name, "src", "internal", "version.ts");
  if (!existsSync(versionFile)) continue;

  const { version } = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
  const source = readFileSync(versionFile, "utf8");
  if (!versionPattern.test(source)) {
    throw new Error(`${versionFile} has no \`export const packageVersion = "...";\``);
  }

  const next = source.replace(versionPattern, `export const packageVersion = "${version}";`);
  if (next !== source) {
    writeFileSync(versionFile, next);
    console.log(`${name}: packageVersion = ${version}`);
  }
}
