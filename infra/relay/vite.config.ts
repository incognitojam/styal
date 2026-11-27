import { defineConfig } from "vite-plus/test/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "../../vite.config.ts",
        test: {
          name: "relay-node",
          maxWorkers: 1,
          exclude: ["**/node_modules/**", "src/objects/**/*.workers.test.ts"],
        },
      },
      "./vitest.objects.config.ts",
    ],
  },
});
