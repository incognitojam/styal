import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus/test/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/objects/test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-06-01",
        durableObjects: {
          ALLOCATION_ROUTES: { className: "AllocationRouteObject", useSQLite: true },
          ENVIRONMENTS: { className: "EnvironmentObject", useSQLite: true },
          EMAILS: { className: "EmailObject", useSQLite: true },
          CREDENTIAL_ROUTES: { className: "CredentialRouteObject", useSQLite: true },
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
