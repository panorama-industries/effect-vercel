import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { mergeConfig } from "vitest/config";

import { sharedConfig } from "../../vitest.shared.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));

/**
 * Conformance tests against real Blob stores. Reads `BLOB_READ_WRITE_TOKEN_PRIVATE` and
 * `BLOB_READ_WRITE_TOKEN_PUBLIC` from the repository's `.env` or the environment; a store without
 * a token is skipped.
 */
const config = mergeConfig(sharedConfig, {
  root,
  test: {
    env: existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {},
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

// `mergeConfig` concatenates arrays, so replace the shared `include` instead of extending it.
config.test = { ...config.test, include: ["test/live/**/*.test.ts"] };

export default config;
