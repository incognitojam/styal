import { expect, it } from "vite-plus/test";
import { compareReviewPaths } from "./reviewPathOrder.ts";

it("orders source, tests and generated paths across languages without changing the input", () => {
  const paths = [
    "uv.lock",
    "deno.lock",
    "src/ThingTests.swift",
    "src/z.ts",
    "src/test_api.py",
    "src/a10.ts",
    "src/a2.ts",
    "drizzle/meta/_journal.json",
    "src/api_test.go",
    "drizzle/0001_add.sql",
    "src/api.test.ts",
    "__fixtures__/sample.json",
    "src/api.gen.ts",
    "src/Thing.swift",
  ];
  expect(paths.toSorted(compareReviewPaths)).toEqual([
    "drizzle/0001_add.sql",
    "src/a2.ts",
    "src/a10.ts",
    "src/Thing.swift",
    "src/z.ts",
    "__fixtures__/sample.json",
    "src/api_test.go",
    "src/api.test.ts",
    "src/test_api.py",
    "src/ThingTests.swift",
    "deno.lock",
    "drizzle/meta/_journal.json",
    "src/api.gen.ts",
    "uv.lock",
  ]);
  expect(paths[0]).toBe("uv.lock");
});
