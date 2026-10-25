import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../vite.config.ts";

// Each test file starts its own server and browser, so files can run in parallel. Startup
// covers a server boot and a provider status check, which takes longer than unit tests allow.
// Tests under tests/network need npm and GitHub releases, so they run only with E2E_NETWORK=1.
// Task runner settings such as the shared cache may only be set in the workspace root config.
const { run: _run, ...testConfig } = baseConfig;

export default mergeConfig(
  testConfig,
  defineConfig({
    test: {
      include: [process.env.E2E_NETWORK === "1" ? "tests/network/*.e2e.ts" : "tests/*.e2e.ts"],
      setupFiles: ["support/setup.ts"],
      hookTimeout: 120_000,
      testTimeout: 90_000,
    },
  }),
);
