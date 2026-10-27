import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
  },
  // Must be top-level: plugins added inside `overrides` don't get category-based rules.
  plugins: ["typescript", "unicorn", "oxc", "vitest"],
  ignorePatterns: ["tools/oxlint/anti-slop/**"],
  jsPlugins: [{ name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" }],
  rules: {
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
});
