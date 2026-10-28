import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Shared Vitest settings for every package. Workspace packages resolve to their TypeScript sources so
 * tests never depend on a prior build.
 */
export const sharedConfig = defineConfig({
  resolve: {
    alias: [
      {
        find: /^@panorama-industries\/effect-vercel-core\/testing$/,
        replacement: source("./packages/core/src/testing/index.ts"),
      },
      {
        find: /^@panorama-industries\/effect-vercel-core$/,
        replacement: source("./packages/core/src/index.ts"),
      },
      {
        find: /^@panorama-industries\/effect-vercel-queue$/,
        replacement: source("./packages/queue/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
