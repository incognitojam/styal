import { describe, expect, it } from "@effect/vitest";
import { worktreeCleanupPatternProblem } from "@t3tools/contracts";
import { matchesWorktreeCleanupPattern } from "./worktreeCleanupPatterns.ts";
import { parseStyalProjectFileResult, buildStyalProjectFileJsonSchema } from "./projectFile.ts";

describe("worktree cleanup patterns", () => {
  it.each([
    "",
    "/dist",
    "C:/dist",
    "dist/",
    "a//b",
    "a/../b",
    "./dist",
    "a/./b",
    "a\\b",
    "!dist",
    "a**b",
    "a/**b/c",
    "*",
    "**",
    "**/*",
    "a/**",
    "a".repeat(513),
  ])("refuses invalid pattern %j with its rule", (pattern) => {
    expect(worktreeCleanupPatternProblem(pattern)).toContain(JSON.stringify(pattern));
    const result = parseStyalProjectFileResult(JSON.stringify({ worktreeCleanup: [pattern] }));
    expect(result.status).toBe("partial");
    if (result.status === "partial")
      expect(result.issues[0]?.message).toContain(pattern === "" ? '""' : JSON.stringify(pattern));
  });
  it.each([
    ["dist", "dist", true],
    ["dist", "dist\n", false],
    ["dist", "apps/dist", false],
    ["**/dist", "dist", true],
    ["**/dist", "apps/web/dist", true],
    ["apps/*/dist", "apps/web/dist", true],
    ["apps/*/dist", "apps/a/b/dist", false],
    ["apps/**/dist", "apps/dist", true],
    ["apps/**/dist", "apps/a/b/dist", true],
    ["cache.*", "cache.json", true],
    ["cache.*", "cacheXjson", false],
    ["**/.git", ".git", false],
    ["**/dist", ".git/dist", false],
    ["**/dist", "a/.git/dist", false],
    ["[ab]", "a", false],
    ["[ab]", "[ab]", true],
    ["dist", "../dist", false],
    ["**/dist", "/dist", false],
  ])("matches %j against %j as %j", (pattern, path, matches) => {
    expect(matchesWorktreeCleanupPattern(pattern, path)).toBe(matches);
  });
  it("normalizes whitespace before validating and exposes independent pattern rules", () => {
    const parsed = parseStyalProjectFileResult(
      JSON.stringify({ worktreeCleanup: [" dist ", "  **/node_modules  "] }),
    );
    expect(parsed.file?.worktreeCleanup).toEqual(["dist", "**/node_modules"]);
    expect(parseStyalProjectFileResult(JSON.stringify({ worktreeCleanup: ["   "] })).status).toBe(
      "partial",
    );
    expect(
      parseStyalProjectFileResult(JSON.stringify({ worktreeCleanup: ["  **/*  "] })).status,
    ).toBe("partial");
  });
  it("publishes the field and preserves the entire list exactly", () => {
    const patterns = ["node_modules", "**/dist", "node_modules"];
    const parsed = parseStyalProjectFileResult(JSON.stringify({ worktreeCleanup: patterns }));
    expect(parsed.file?.worktreeCleanup).toEqual(patterns);
    expect(JSON.stringify(buildStyalProjectFileJsonSchema())).toContain("worktreeCleanup");
    expect(
      parseStyalProjectFileResult(JSON.stringify({ worktreeCleanup: Array(101).fill("dist") }))
        .status,
    ).toBe("partial");
  });
});
