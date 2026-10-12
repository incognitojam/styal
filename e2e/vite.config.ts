import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../vite.config.ts";

// Each test file starts its own server and browser, so files can run in parallel. Startup
// covers a server boot and a provider status check, which takes longer than unit tests allow.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/**/*.e2e.ts"],
      setupFiles: ["support/setup.ts"],
      hookTimeout: 120_000,
      testTimeout: 90_000,
    },
  }),
);
