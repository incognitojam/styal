import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus/test/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/objects/test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-06-01",
        durableObjects: {
          ACCOUNTS: { className: "AccountObject", useSQLite: true },
          INVENTORY: { className: "InventoryObject", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    name: "relay-objects",
    testTimeout: 60_000,
    include: ["src/objects/**/*.workers.test.ts"],
    maxWorkers: 1,
    isolate: true,
  },
});
