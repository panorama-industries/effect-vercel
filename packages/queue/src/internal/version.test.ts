import { assert, describe, it } from "@effect/vitest";
import { readFileSync } from "node:fs";

import { packageName, packageVersion } from "./version.ts";

describe("version", () => {
  it("matches package.json", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    assert.strictEqual(packageName, manifest.name);
    assert.strictEqual(packageVersion, manifest.version);
  });
});
