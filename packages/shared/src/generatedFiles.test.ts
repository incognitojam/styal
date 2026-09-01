import { describe, expect, it } from "vite-plus/test";

import { isGeneratedLockfilePath } from "./generatedFiles.ts";

describe("isGeneratedLockfilePath", () => {
  it.each([
    "bun.lock",
    "frontend/package-lock.json",
    "crates\\server\\Cargo.lock",
    "vendor/composer.lock",
    "deno.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
  ])("recognizes %s", (path) => {
    expect(isGeneratedLockfilePath(path)).toBe(true);
  });

  it.each(["src/lock.ts", "package.json", "docs/yarn.lock.md", "cargo.lock"])(
    "leaves %s open",
    (path) => {
      expect(isGeneratedLockfilePath(path)).toBe(false);
    },
  );
});
