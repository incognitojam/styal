import { describe, expect, it } from "vite-plus/test";

import { diffFileTier, orderDiffFiles, orderUnloadedDiffFiles } from "./diffFileOrder.ts";

interface Entry {
  readonly path: string;
  readonly changedLines: ReadonlyArray<string>;
}

function file(path: string, changedLines: ReadonlyArray<string> = []): Entry {
  return { path, changedLines };
}

const accessors = {
  path: (entry: Entry) => entry.path,
  changedLines: (entry: Entry) => entry.changedLines,
};

function order(files: ReadonlyArray<Entry>, generatedPaths?: ReadonlyArray<string>): Array<string> {
  return orderDiffFiles(files, accessors, generatedPaths).map((entry) => entry.path);
}

describe("diffFileTier", () => {
  it("puts lockfiles, snapshots and build output last", () => {
    expect(diffFileTier("pnpm-lock.yaml")).toBe("generated");
    expect(diffFileTier("apps/web/package-lock.json")).toBe("generated");
    expect(diffFileTier("go.sum")).toBe("generated");
    expect(diffFileTier("src/__snapshots__/app.ts")).toBe("generated");
    expect(diffFileTier("src/app.test.ts.snap")).toBe("generated");
    expect(diffFileTier("src/api.generated.ts")).toBe("generated");
    expect(diffFileTier("public/app.min.js")).toBe("generated");
    expect(diffFileTier("dist/app.js")).toBe("generated");
    expect(diffFileTier("packages/core/vendor/lib.js")).toBe("generated");
    expect(diffFileTier("src/routeTree.gen.ts")).toBe("generated");
  });

  it("puts drizzle-kit metadata last but keeps its SQL migrations as source", () => {
    expect(diffFileTier("drizzle/meta/_journal.json")).toBe("generated");
    expect(diffFileTier("drizzle/meta/0004_snapshot.json")).toBe("generated");
    expect(diffFileTier("drizzle/0004_small_mentor.sql")).toBe("source");
    expect(diffFileTier("src/meta/settings.json")).toBe("source");
  });

  it("recognises a test by its name or by the directory holding it", () => {
    expect(diffFileTier("src/app.test.ts")).toBe("test");
    expect(diffFileTier("src/app.spec.tsx")).toBe("test");
    expect(diffFileTier("src/__tests__/app.ts")).toBe("test");
    expect(diffFileTier("test/app.ts")).toBe("test");
    expect(diffFileTier("tests/helpers/app.ts")).toBe("test");
  });

  it("recognises test naming outside JavaScript", () => {
    expect(diffFileTier("Tests/AppTests/RuleRepairTests.swift")).toBe("test");
    expect(diffFileTier("Sources/AppUITests/LaunchFlow.swift")).toBe("test");
    expect(diffFileTier("src/main/java/com/example/ParserTest.java")).toBe("test");
    expect(diffFileTier("internal/parser/parser_test.go")).toBe("test");
    expect(diffFileTier("pkg/test_parser.py")).toBe("test");
    expect(diffFileTier("pkg/parser_test.py")).toBe("test");
    expect(diffFileTier("lib/parser_spec.rb")).toBe("test");
    expect(diffFileTier("Test/Parser.cs")).toBe("test");
  });

  it("keeps source that only resembles a test name", () => {
    expect(diffFileTier("Sources/App/Latest.swift")).toBe("source");
    expect(diffFileTier("Sources/App/ABTest.swift")).toBe("source");
    expect(diffFileTier("docs/api_spec.yaml")).toBe("source");
    expect(diffFileTier("src/test_utils.ts")).toBe("source");
    expect(diffFileTier("Sources/Contests/Bracket.swift")).toBe("source");
  });

  it("counts fixtures and test harnesses as tests", () => {
    expect(diffFileTier("src/orchestration/testkit/fixtures/plan/codex_transcript.ndjson")).toBe(
      "test",
    );
    expect(diffFileTier("src/__fixtures__/response.json")).toBe("test");
    expect(diffFileTier("internal/parser/testdata/input.txt")).toBe("test");
    expect(diffFileTier("src/testkit/harness.ts")).toBe("test");
  });

  it("treats everything else as source, including files merely named like a directory", () => {
    expect(diffFileTier("src/app.ts")).toBe("source");
    expect(diffFileTier("src/testing.ts")).toBe("source");
    expect(diffFileTier("src/fixtures.ts")).toBe("source");
    expect(diffFileTier("src/dist.ts")).toBe("source");
    expect(diffFileTier("src/codegen.ts")).toBe("source");
  });

  it("lets a repository attribution mark any path generated", () => {
    expect(diffFileTier("src/schema.ts", new Set(["src/schema.ts"]))).toBe("generated");
    expect(diffFileTier("src/schema.ts", new Set(["src/other.ts"]))).toBe("source");
  });
});

describe("orderDiffFiles", () => {
  it("places source before tests and generated files across path conventions", () => {
    const source = ["src/app.ts", "src/dist.ts", "src/testing.ts"];
    const tests = [
      "src/__tests__/app.ts",
      "src/app.spec.tsx",
      "src/app.test.ts",
      "test/app.ts",
      "tests/helpers/app.ts",
    ];
    const generated = [
      "apps/web/package-lock.json",
      "dist/app.js",
      "packages/core/vendor/lib.js",
      "pnpm-lock.yaml",
      "public/app.min.js",
      "src/__snapshots__/app.ts",
      "src/api.generated.ts",
      "src/app.test.ts.snap",
    ];
    expect(
      order([...generated, ...tests, ...source].toReversed().map((path) => file(path))),
    ).toEqual([...source, ...tests, ...generated]);
  });

  it("answers an empty diff with an empty order", () => {
    expect(order([])).toEqual([]);
  });

  it("keeps every entry of a path the patch lists more than once", () => {
    const first = file("src/a.ts", ["first"]);
    const second = file("src/a.ts", ["second"]);
    expect(orderDiffFiles([second, file("src/a.test.ts"), first], accessors)).toEqual([
      second,
      first,
      file("src/a.test.ts"),
    ]);
  });

  it("puts a dependency before what imports it", () => {
    expect(order([file("src/a.ts", ['import { b } from "./b";']), file("src/b.ts")])).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("follows a chain the whole way down", () => {
    expect(
      order([
        file("src/a.ts", ['import { b } from "./b";']),
        file("src/b.ts", ['import { c } from "./c";']),
        file("src/c.ts"),
      ]),
    ).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"]);
  });

  it("resolves a specifier that climbs out of the importer's directory", () => {
    expect(
      order([file("src/ui/a.ts", ['import { b } from "../lib/b";']), file("src/lib/b.ts")]),
    ).toEqual(["src/lib/b.ts", "src/ui/a.ts"]);
  });

  it("resolves a directory specifier to that directory's index file", () => {
    expect(
      order([file("src/a.ts", ['import { b } from "./lib";']), file("src/lib/index.ts")]),
    ).toEqual(["src/lib/index.ts", "src/a.ts"]);
  });

  it("falls back to the specifier's last segment when the path does not line up", () => {
    expect(order([file("src/a.ts", ['import { b } from "~/lib/b";']), file("lib/b.ts")])).toEqual([
      "lib/b.ts",
      "src/a.ts",
    ]);
  });

  it("ignores an ambiguous last segment rather than guessing", () => {
    expect(
      order([
        file("src/a.ts", ['import { b } from "~/somewhere/b";']),
        file("one/b.ts"),
        file("two/b.ts"),
      ]),
    ).toEqual(["one/b.ts", "src/a.ts", "two/b.ts"]);
  });

  it("resolves a specifier naming an extension, including the .js beside a .ts", () => {
    expect(order([file("src/a.ts", ['import { b } from "./b.js";']), file("src/b.ts")])).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("reads require and bare imports too", () => {
    expect(
      order([
        file("src/a.ts", ['const b = require("./b");', 'import "./c";']),
        file("src/b.ts"),
        file("src/c.ts"),
      ]),
    ).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
  });

  it("falls back to path order inside a cycle", () => {
    expect(
      order([
        file("src/b.ts", ['import { a } from "./a";']),
        file("src/a.ts", ['import { b } from "./b";']),
      ]),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("places a cycle-broken file exactly once even when its imports later resolve", () => {
    expect(
      order([
        file("src/a.ts", ['import { b } from "./b";']),
        file("src/b.ts", ['import { a } from "./a";']),
        file("src/c.ts", ['import { a } from "./a";']),
      ]),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("clusters unrelated files by path", () => {
    expect(order([file("src/ui/b.ts"), file("src/lib/z.ts"), file("src/lib/a.ts")])).toEqual([
      "src/lib/a.ts",
      "src/lib/z.ts",
      "src/ui/b.ts",
    ]);
  });

  it("keeps the tiers apart and orders tests by the source they cover", () => {
    expect(
      order([
        file("pnpm-lock.yaml"),
        file("src/a.test.ts"),
        file("src/__tests__/b.ts"),
        file("src/a.ts", ['import { b } from "./b";']),
        file("src/b.ts"),
        file("dist/a.js"),
      ]),
    ).toEqual([
      "src/b.ts",
      "src/a.ts",
      "src/__tests__/b.ts",
      "src/a.test.ts",
      "dist/a.js",
      "pnpm-lock.yaml",
    ]);
  });

  it("reads a fixture after the tests, not among the source", () => {
    expect(
      order([
        file("src/testkit/fixtures/plan/transcript.ndjson"),
        file("src/adapters/CodexAdapter.ts", ['import { catalog } from "../provider/catalog.ts";']),
        file("src/adapters/CodexAdapter.test.ts"),
        file("src/provider/catalog.ts"),
      ]),
    ).toEqual([
      "src/provider/catalog.ts",
      "src/adapters/CodexAdapter.ts",
      "src/adapters/CodexAdapter.test.ts",
      "src/testkit/fixtures/plan/transcript.ndjson",
    ]);
  });

  it("pairs Swift, Go and Python tests with the source they cover", () => {
    expect(
      order([
        file("Tests/AppTests/RuleRepairTests.swift"),
        file("Tests/AppTests/DiscoveryTests.swift"),
        file("Sources/App/RuleRepair.swift"),
        file("Sources/App/Discovery.swift"),
        file("pkg/test_zeta.py"),
        file("pkg/zeta.py"),
        file("cmd/alpha_test.go"),
        file("cmd/alpha.go"),
      ]),
    ).toEqual([
      "cmd/alpha.go",
      "pkg/zeta.py",
      "Sources/App/Discovery.swift",
      "Sources/App/RuleRepair.swift",
      "cmd/alpha_test.go",
      "pkg/test_zeta.py",
      "Tests/AppTests/DiscoveryTests.swift",
      "Tests/AppTests/RuleRepairTests.swift",
    ]);
  });

  it("puts a test with no source in the diff after the ones that have theirs", () => {
    expect(order([file("src/orphan.spec.ts"), file("src/a.test.ts"), file("src/a.ts")])).toEqual([
      "src/a.ts",
      "src/a.test.ts",
      "src/orphan.spec.ts",
    ]);
  });

  it("moves a repository-attributed generated file behind sources named like it", () => {
    expect(order([file("src/schema.ts"), file("src/app.ts")], ["src/schema.ts"])).toEqual([
      "src/app.ts",
      "src/schema.ts",
    ]);
  });

  it("orders the same diff the same way whatever order it arrives in", () => {
    const files = [
      file("src/a.ts", ['import { b } from "./b";']),
      file("src/b.ts"),
      file("src/c.ts"),
      file("src/a.test.ts"),
      file("yarn.lock"),
    ];
    expect(order(files)).toEqual(order(files.toReversed()));
  });
});

describe("orderUnloadedDiffFiles", () => {
  it("orders files by tier from their paths alone", () => {
    const files = [
      { path: "bun.lock", additions: 900 },
      { path: "src/z.test.ts", additions: 4 },
      { path: "src/z.ts", additions: 2 },
      { path: "src/a.test.ts", additions: 3 },
      { path: "src/a.ts", additions: 1 },
      { path: "src/schema.ts", additions: 7 },
    ];

    expect(orderUnloadedDiffFiles(files, ["src/schema.ts"]).map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/z.ts",
      "src/a.test.ts",
      "src/z.test.ts",
      "bun.lock",
      "src/schema.ts",
    ]);
  });
});
