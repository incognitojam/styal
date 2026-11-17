import { describe, expect, it } from "@effect/vitest";
import { regenerableFilePatternProblem } from "@t3tools/contracts";
import { matchesRegenerableFilePattern } from "./regenerableFilePatterns.ts";
import { parseStyalProjectFileResult, buildStyalProjectFileJsonSchema } from "./projectFile.ts";

describe("regenerable file patterns", () => {
  it.each([
    "",
    "/dist",
    "C:/dist",
    "dist//",
    "a//b",
    "a/../b",
    "./dist",
    "a/./b",
    "a\\b",
    "!dist",
    "?*",
    "cache[ab]",
    "cache]",
    "cache{a,b}",
    "a**b",
    "a/**b/c",
    "*",
    "**",
    "**/*",
    "a/**",
    ".git",
    "**/.git",
    ".GIT/cache",
    "a".repeat(513),
  ])("refuses invalid pattern %j with its rule", (pattern) => {
    expect(regenerableFilePatternProblem(pattern)).toContain(JSON.stringify(pattern));
    const schema = buildStyalProjectFileJsonSchema();
    const { items } = (
      schema.properties as { regenerableFiles: { items: { pattern: string; maxLength: number } } }
    ).regenerableFiles;
    expect(pattern.length > items.maxLength || !new RegExp(items.pattern, "u").test(pattern)).toBe(
      true,
    );
    const result = parseStyalProjectFileResult(JSON.stringify({ regenerableFiles: [pattern] }));
    expect(result.status).toBe("partial");
    if (result.status === "partial")
      expect(result.issues[0]?.message).toContain(pattern === "" ? '""' : JSON.stringify(pattern));
  });
  it.each([
    ["dist", "dist", true],
    ["dist", "dist/", true],
    ["dist/", "dist/", true],
    ["dist/", "dist", false],
    ["**/dist/", "dist/", true],
    ["**/dist/", "apps/web/dist/", true],
    ["**/dist/", "apps/web/dist", false],
    ["apps/**/dist/", "apps/dist/", true],
    ["apps/**/dist/", "apps/a/b/dist/", true],
    ["dist", "Dist", false],
    ["café", "cafe\u0301", false],
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
    ["[ab]", "[ab]", false],
    ["dist", "../dist", false],
    ["**/dist", "/dist", false],
  ])("matches %j against %j as %j", (pattern, path, matches) => {
    expect(matchesRegenerableFilePattern(pattern, path)).toBe(matches);
  });
  it("normalizes whitespace before validating and exposes independent pattern rules", () => {
    const parsed = parseStyalProjectFileResult(
      JSON.stringify({ regenerableFiles: [" dist/ ", "  **/node_modules/  "] }),
    );
    expect(parsed.file?.regenerableFiles).toEqual(["dist/", "**/node_modules/"]);
    expect(parseStyalProjectFileResult(JSON.stringify({ regenerableFiles: ["   "] })).status).toBe(
      "partial",
    );
    for (const pattern of ["  **/*  ", "**/ ", "a/*/ "]) {
      expect(
        parseStyalProjectFileResult(JSON.stringify({ regenerableFiles: [pattern] })).status,
      ).toBe("partial");
      const schema = buildStyalProjectFileJsonSchema();
      const items = (schema.properties as { regenerableFiles: { items: { pattern: string } } })
        .regenerableFiles.items;
      expect(new RegExp(items.pattern, "u").test(pattern)).toBe(false);
    }
  });
  it("publishes the field and preserves the entire list exactly", () => {
    const patterns = ["node_modules", "**/dist", "node_modules", "**/dist/", "node_modules/"];
    const parsed = parseStyalProjectFileResult(JSON.stringify({ regenerableFiles: patterns }));
    expect(parsed.file?.regenerableFiles).toEqual(patterns);
    const schema = buildStyalProjectFileJsonSchema();
    expect(schema.properties).toMatchObject({
      regenerableFiles: {
        items: { description: expect.stringContaining("single trailing /") },
      },
    });
    const items = (
      schema.properties as { regenerableFiles: { items: { pattern: string; description: string } } }
    ).regenerableFiles.items;
    expect(items.description).toContain("matches folders only");
    for (const pattern of patterns) expect(new RegExp(items.pattern, "u").test(pattern)).toBe(true);
    expect(
      parseStyalProjectFileResult(JSON.stringify({ regenerableFiles: Array(101).fill("dist") }))
        .status,
    ).toBe("partial");
  });
});
