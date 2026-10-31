import { configDefaults, mergeConfig } from "vitest/config";

import { sharedConfig } from "../../vitest.shared.ts";

export default mergeConfig(sharedConfig, {
  test: {
    // Runs against real stores with `pnpm test:live`; see `vitest.live.config.ts`.
    exclude: [...configDefaults.exclude, "test/live/**"],
  },
});
