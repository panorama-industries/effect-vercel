#!/usr/bin/env node
/**
 * Get new packages ready for npm trusted publishing, which can only be configured on a package that
 * already exists on npm.
 *
 * For each published workspace package missing from npm, publish a `0.0.0` placeholder from your
 * machine and trust `.github/workflows/release.yml` to publish it. The Release workflow then
 * publishes the real version with OIDC. Runs `npm login` when needed; npm asks for 2FA on the
 * publish and on the first trust request.
 *
 * Usage, from the repository root:
 *
 *   node scripts/bootstrap-npm.mjs          # bootstrap every package missing from npm
 *   node scripts/bootstrap-npm.mjs --check  # only list them and exit 1 if any (used in CI)
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = "release.yml";
const check = process.argv.includes("--check");

// npm refuses to run inside the repository because `devEngines` asks for pnpm.
const scratch = mkdtempSync(join(tmpdir(), "bootstrap-npm-"));
const npm = (args, options) =>
  spawnSync("npm", args, { cwd: scratch, encoding: "utf8", ...options });

const isPublished = (name) => {
  const result = npm(["view", name, "name"]);
  if (result.status === 0) return true;
  if (result.stderr.includes("E404")) return false;
  throw new Error(`npm view ${name} failed:\n${result.stderr}`);
};

const githubRepository = (pkg) => {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(pkg.repository?.url ?? "");
  if (!match) throw new Error(`${pkg.name} has no GitHub \`repository.url\``);
  return match[1];
};

const publishPlaceholder = (pkg) => {
  const dir = join(scratch, pkg.name.replace("/", "__"));
  mkdirSync(dir);
  const placeholder = {
    name: pkg.name,
    version: "0.0.0",
    description: `Placeholder for ${pkg.name}. Real releases are published from CI.`,
    license: pkg.license,
    repository: pkg.repository,
    publishConfig: { access: "public" },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(placeholder, null, 2)}\n`);
  writeFileSync(join(dir, "README.md"), `# ${pkg.name}\n\n${placeholder.description}\n`);
  return npm(["publish"], { cwd: dir, stdio: "inherit" }).status === 0;
};

const trustArgs = (pkg) => [
  "trust",
  "github",
  pkg.name,
  "--file",
  workflow,
  "--repo",
  githubRepository(pkg),
  "--allow-publish",
  "--yes",
];

try {
  const missing = readdirSync(join(root, "packages"))
    .map((dir) => join(root, "packages", dir, "package.json"))
    .filter(existsSync)
    .map((file) => JSON.parse(readFileSync(file, "utf8")))
    .filter((pkg) => !pkg.private && !isPublished(pkg.name));

  if (missing.length === 0) {
    console.log("Every package is on npm.");
  } else if (check) {
    console.error(`Not on npm yet, so trusted publishing cannot publish them:`);
    for (const pkg of missing) console.error(`  ${pkg.name}`);
    console.error(`\nRun \`pnpm bootstrap:npm\` locally, then re-run this workflow.`);
    process.exitCode = 1;
  } else {
    if (npm(["whoami"]).status !== 0 && npm(["login"], { stdio: "inherit" }).status !== 0) {
      throw new Error("npm login failed");
    }
    for (const pkg of missing) {
      console.log(`\n${pkg.name}: publishing placeholder 0.0.0`);
      if (!publishPlaceholder(pkg))
        throw new Error(`Publishing the ${pkg.name} placeholder failed`);

      console.log(`${pkg.name}: trusting ${githubRepository(pkg)} ${workflow}`);
      if (npm(trustArgs(pkg), { stdio: "inherit" }).status !== 0) {
        throw new Error(
          `Trusting ${pkg.name} failed. Retry with:\n  npm ${trustArgs(pkg).join(" ")}`,
        );
      }
    }
    console.log(`\nDone. Re-run the Release workflow, or merge, to publish the real versions.`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
