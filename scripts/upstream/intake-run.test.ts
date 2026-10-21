import { assert, describe, it } from "@effect/vitest";

import {
  addedLineNumbers,
  applyOverridePins,
  autoStopReasons,
  batchLength,
  describeNativeFingerprint,
  describeShippedNativeRuntime,
  nativeFingerprintVerdict,
  newestAndroidReleaseTag,
  draftAdaptationNote,
  hasTypecheckTask,
  intakeCommitMessage,
  ledgerFeaturesByPath,
  lockfilePackages,
  mergedModuleMoves,
  moveLedgerPaths,
  overrideSelector,
  patchOverridePins,
  plannedTestRuns,
  queuedAutoMerges,
  relatedTestFiles,
  rewriteServiceKeyText,
  summarizeSurvey,
  touchesNativeFingerprint,
  verificationEnvironment,
} from "./intake-run.ts";

describe("lockfilePackages", () => {
  it("reads resolved package versions without peer suffixes", () => {
    const lockfile = [
      "packages:",
      "",
      "  '@effect/sql-d1@4.0.0':",
      "    resolution: {integrity: sha512-x}",
      "  astro@7.3.5(@types/node@24.12.4):",
      "    dependencies:",
      "      vite: 7.0.0",
      "",
    ].join("\n");
    assert.deepStrictEqual([...lockfilePackages(lockfile)].toSorted(), [
      "@effect/sql-d1@4.0.0",
      "astro@7.3.5",
    ]);
  });
});

describe("overrideSelector", () => {
  it("pins a version within its major line, or by name for 0.x versions", () => {
    assert.strictEqual(overrideSelector("undici", "6.29.0"), "undici@^6.0.0");
    assert.strictEqual(overrideSelector("verkit", "0.4.1"), "verkit");
  });
});

describe("draftAdaptationNote", () => {
  it("describes renames, service keys, and the lockfile, and names the features they keep", () => {
    const draft = draftAdaptationNote(
      [
        {
          kind: "identity",
          path: "apps/server/src/mcp/toolkits/pullRequests/tools.ts",
          detail: "T3 Code -> styal",
        },
        {
          kind: "service-keys",
          path: "apps/server/src/secrets/SecretRequests.ts",
          detail: "t3/ -> @styal/cli/",
        },
        { kind: "additions", path: "packages/contracts/src/index.ts" },
      ],
      { missing: [], stale: [], pinned: ["astro@^7.0.0"] },
    );
    assert.strictEqual(
      draft.note,
      "Upstream's new text in `apps/server/src/mcp/toolkits/pullRequests/tools.ts` takes the fork's naming (`T3 Code` to `styal`), as the fork's existing text there does. The new service keys in `apps/server/src/secrets/SecretRequests.ts` use the fork's package name. The lockfile is regenerated from the fork's dependency graph and resolves the same new versions as upstream's.",
    );
    assert.deepStrictEqual(draft.features, [
      "fork-agent-integration-identity",
      "fork-distribution-identity",
    ]);
  });

  it("writes no note for changes that keep both sides' lines", () => {
    assert.deepStrictEqual(draftAdaptationNote([{ kind: "additions", path: "a.ts" }]), {
      note: null,
      features: [],
    });
  });
});

describe("intakeCommitMessage", () => {
  it("keeps upstream's message and adds provenance after any fork note", () => {
    assert.strictEqual(
      intakeCommitMessage({
        upstreamMessage: "fix(server): a fix (#123)\n\nCo-authored-by: A <a@example.com>\n",
        upstreamSha: "a".repeat(40),
        pr: 123,
        note: "Keeps the fork's name.",
        features: ["fork-distribution-identity"],
      }),
      `fix(server): a fix (#123)\n\nCo-authored-by: A <a@example.com>\n\nFork adaptation: Keeps the fork's name.\n\n(cherry picked from commit ${"a".repeat(40)})\nUpstream-PR: 123\nFork-Feature: fork-distribution-identity\n`,
    );
  });

  it("joins provenance to a trailer block that ends upstream's message, as cherry-pick -x does", () => {
    assert.strictEqual(
      intakeCommitMessage({
        upstreamMessage: "fix: x (#1)\n\nCo-authored-by: A <a@example.com>\n",
        upstreamSha: "c".repeat(40),
        pr: 1,
        note: null,
        features: [],
      }),
      `fix: x (#1)\n\nCo-authored-by: A <a@example.com>\n(cherry picked from commit ${"c".repeat(40)})\nUpstream-PR: 1\n`,
    );
  });

  it("cites a direct upstream commit by SHA", () => {
    assert.include(
      intakeCommitMessage({
        upstreamMessage: "fix: direct\n",
        upstreamSha: "b".repeat(40),
        pr: null,
        note: null,
        features: [],
      }),
      `Upstream-Commit: ${"b".repeat(40)}`,
    );
  });
});

describe("rewriteServiceKeyText", () => {
  it("gives keys the fork's package name, including keys wrapped onto the next line", () => {
    const text = [
      'export class A extends Context.Service<A, {}>()("t3/provider/A") {}',
      "export class B extends LayerMap.Service<B>()(",
      '  "t3/workspace/B",',
      ") {}",
      'const unrelated = "t3/elsewhere";',
    ].join("\n");
    assert.strictEqual(
      rewriteServiceKeyText(text, "t3", "@styal/cli"),
      [
        'export class A extends Context.Service<A, {}>()("@styal/cli/provider/A") {}',
        "export class B extends LayerMap.Service<B>()(",
        '  "@styal/cli/workspace/B",',
        ") {}",
        'const unrelated = "t3/elsewhere";',
      ].join("\n"),
    );
  });
});

describe("moveLedgerPaths", () => {
  it("points moved paths at their new files and keeps each edited list sorted", () => {
    const ledger = [
      "  - id: provider-auto-updates",
      "    implementation_paths:",
      "      - apps/server/src/provider/Layers/ProviderRegistry.ts",
      "      - apps/server/src/provider/ProviderAutoUpdater.ts",
      "    tests:",
      "      - apps/server/src/provider/Layers/ProviderRegistry.test.ts",
    ].join("\n");
    const result = moveLedgerPaths(
      ledger,
      new Map([
        [
          "apps/server/src/provider/Layers/ProviderRegistry.ts",
          "apps/server/src/provider/ProviderRegistry.ts",
        ],
        [
          "apps/server/src/provider/Layers/ProviderRegistry.test.ts",
          "apps/server/src/provider/ProviderRegistry.test.ts",
        ],
      ]),
    );
    assert.strictEqual(result.moved, 2);
    assert.strictEqual(
      result.text,
      [
        "  - id: provider-auto-updates",
        "    implementation_paths:",
        "      - apps/server/src/provider/ProviderAutoUpdater.ts",
        "      - apps/server/src/provider/ProviderRegistry.ts",
        "    tests:",
        "      - apps/server/src/provider/ProviderRegistry.test.ts",
      ].join("\n"),
    );
  });
});

describe("hasTypecheckTask", () => {
  it("finds a typecheck script or a Vite+ typecheck task", () => {
    assert.isTrue(hasTypecheckTask('{ "scripts": { "typecheck": "tsc-rs --noEmit" } }', ""));
    assert.isTrue(
      hasTypecheckTask(
        '{ "scripts": { "dev": "vp dev" } }',
        'run: {\n    tasks: {\n      typecheck: {\n        command: "tsc-rs --noEmit",',
      ),
    );
    assert.isFalse(
      hasTypecheckTask(
        '{ "scripts": { "dev": "vp dev" } }',
        'dependsOn: ["@t3tools/web#typecheck"]',
      ),
    );
  });
});

describe("verificationEnvironment", () => {
  it("drops a styal session's server settings and service launcher context", () => {
    assert.deepStrictEqual(
      verificationEnvironment({
        PATH: "/usr/bin",
        T3CODE_PORT: "3773",
        STYAL_HOME: "/home/a/.styal",
        T3_SERVICE_LAUNCHER_CONTEXT: "{}",
        T3_OTHER: "kept",
      }),
      { PATH: "/usr/bin", T3_OTHER: "kept" },
    );
  });
});

describe("relatedTestFiles", () => {
  const workspace = new Map([
    [
      "@t3tools/provider-core",
      {
        directory: "packages/provider-core",
        exports: {
          "./server/auth": { types: "./src/server/auth.ts", import: "./src/server/auth.ts" },
        },
      },
    ],
  ]);
  const sources: Record<string, string> = {
    "apps/server/src/a.test.ts": 'import { a } from "./a.ts";',
    "apps/server/src/b.test.ts": 'import { b } from "./b";\nvi.mock("../c.js");',
    "apps/server/src/auth.test.ts": 'import { auth } from "@t3tools/provider-core/server/auth";',
    "apps/server/src/indirect.test.ts": 'import { server } from "./server.ts";',
    "apps/web/src/view.test.tsx": 'import { View } from "~/components/View";',
    "apps/server/src/changed.test.ts": "",
  };
  const select = (changed: ReadonlyArray<string>) =>
    relatedTestFiles({
      changed,
      testFiles: Object.keys(sources),
      packageOf: (path) => /^(?:apps|packages)\/[^/]+/u.exec(path)?.[0],
      workspace,
      readFile: (path) => sources[path] ?? "",
    });

  it("selects changed tests and tests that import a changed file directly", () => {
    assert.deepStrictEqual(
      select([
        "apps/server/src/a.ts",
        "apps/server/c.ts",
        "apps/server/src/changed.test.ts",
        "apps/web/src/components/View.tsx",
      ]),
      [
        "apps/server/src/a.test.ts",
        "apps/server/src/b.test.ts",
        "apps/web/src/view.test.tsx",
        "apps/server/src/changed.test.ts",
      ],
    );
  });

  it("follows workspace package exports into other packages", () => {
    assert.deepStrictEqual(select(["packages/provider-core/src/server/auth.ts"]), [
      "apps/server/src/auth.test.ts",
    ]);
  });

  it("leaves tests that reach a changed file only through other modules to Fork CI", () => {
    assert.deepStrictEqual(select(["apps/server/src/server-helpers.ts"]), []);
  });
});

describe("plannedTestRuns", () => {
  const testScripts = new Map([
    ["apps/server", "vp test run"],
    ["packages/shared", "vp test run --config ../../vite.config.ts --dir ."],
    ["apps/marketing", "astro check && vitest"],
  ]);

  it("runs related tests through each package's own test configuration, server files in parallel first", () => {
    assert.deepStrictEqual(
      plannedTestRuns({
        mode: "related",
        touchedPackages: ["apps/server"],
        testScripts,
        relatedTests: [
          "packages/shared/src/git.test.ts",
          "apps/server/src/a.test.ts",
          "apps/server/src/b.test.ts",
          "apps/marketing/src/page.test.ts",
        ],
      }).map(({ name, command, args }) => [name, command, ...args].join(" ")),
      [
        "tests apps/server (2 related files) vp test run --fileParallelism --maxWorkers=5 src/a.test.ts src/b.test.ts",
        "tests apps/marketing (1 related file) pnpm run test",
        "tests packages/shared (1 related file) vp test run --config ../../vite.config.ts --dir . src/git.test.ts",
      ],
    );
  });

  it("runs every touched package's whole suite with --all-tests", () => {
    assert.deepStrictEqual(
      plannedTestRuns({
        mode: "all",
        touchedPackages: ["packages/shared", "apps/server", "packages/no-tests"],
        testScripts,
        relatedTests: [],
      }).map(({ directory, command, args }) => [directory, command, ...args].join(" ")),
      [
        "apps/server pnpm run test --fileParallelism --maxWorkers=5",
        "packages/shared pnpm run test",
      ],
    );
  });
});

describe("mergedModuleMoves", () => {
  it("maps a service file to the module that replaces its folder", () => {
    assert.deepStrictEqual(
      [
        ...mergedModuleMoves(
          ["apps/server/src/provider/Services/ProviderAuthService.ts", "apps/server/src/old.ts"],
          ["apps/server/src/provider/ProviderAuthService.ts", "apps/server/src/web/old.ts"],
        ),
      ],
      [
        [
          "apps/server/src/provider/Services/ProviderAuthService.ts",
          "apps/server/src/provider/ProviderAuthService.ts",
        ],
      ],
    );
  });
});

describe("autoStopReasons", () => {
  const clean = {
    upstreamSha: "a".repeat(40),
    status: "clean" as const,
    adaptations: [],
    unresolved: [],
    identityReview: [],
  };

  it("commits a clean pick and one whose resolutions explain themselves", () => {
    assert.deepStrictEqual(
      autoStopReasons({ outcome: clean, upstreamNames: [], differsWithoutNote: false }),
      [],
    );
    assert.deepStrictEqual(
      autoStopReasons({
        outcome: {
          ...clean,
          status: "resolved",
          adaptations: [{ kind: "identity", path: "docs/user/remote-access.md" }],
          lockfile: { missing: [], stale: [], pinned: [] },
        },
        upstreamNames: [],
        differsWithoutNote: false,
      }),
      [],
    );
  });

  it("hands over conflicts, combined lines, lockfile drift, upstream naming, and unexplained differences", () => {
    assert.deepStrictEqual(
      autoStopReasons({
        outcome: {
          ...clean,
          status: "stopped",
          adaptations: [{ kind: "additions", path: "a.ts" }],
          unresolved: [{ path: "b.ts", hunks: 2 }],
          identityReview: ["c.ts: T3 Code"],
          lockfile: { missing: ["ws@8.22.0"], stale: [], pinned: [] },
        },
        upstreamNames: ["c.ts: T3 Code", "d.test.ts: T3 Connect"],
        differsWithoutNote: true,
      }),
      [
        "unresolved conflict: b.ts",
        "combined lines to review: a.ts",
        "lockfile differs from upstream's",
        "upstream naming: c.ts: T3 Code",
        "upstream naming: d.test.ts: T3 Connect",
        "differs from upstream without a fork note",
      ],
    );
  });
});

describe("batchLength", () => {
  it("ends a batch before the pull request the next commit belongs to", () => {
    const picked = [{ pr: 1 }, { pr: 2 }, { pr: 3 }, { pr: 3 }];
    assert.strictEqual(batchLength(picked, { pr: 3 }), 2);
    assert.strictEqual(batchLength(picked, { pr: 4 }), 4);
    assert.strictEqual(batchLength(picked, { pr: null }), 4);
    assert.strictEqual(batchLength(picked, undefined), 4);
    assert.strictEqual(batchLength([{ pr: 5 }], { pr: 5 }), 0);
  });
});

describe("draftAdaptationNote naming", () => {
  it("describes renamed strings and keeps the agent identity feature for agent paths", () => {
    const draft = draftAdaptationNote([
      {
        kind: "naming",
        path: "apps/server/src/cloud/CloudLink.ts",
        detail: "T3 Connect -> styal Link",
      },
      { kind: "naming", path: "apps/server/src/mcp/WorktreeMcpService.ts", detail: "T3 -> styal" },
    ]);
    assert.strictEqual(
      draft.note,
      "Upstream's new strings in `apps/server/src/cloud/CloudLink.ts`, `apps/server/src/mcp/WorktreeMcpService.ts` use the fork's names (`T3 Connect` to `styal Link`, `T3` to `styal`), as `naming:check` requires.",
    );
    assert.deepStrictEqual(draft.features, ["fork-agent-integration-identity"]);
  });
});

describe("addedLineNumbers", () => {
  it("numbers the lines each file gains in a zero-context diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3,0 +4,2 @@ export const a = 1;",
      '+const b = "T3 Code";',
      "+const c = 2;",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      "diff --git a/docs/user/b.md b/docs/user/b.md",
      "--- a/docs/user/b.md",
      "+++ b/docs/user/b.md",
      "@@ -1 +1 @@",
      "-T3 Code",
      "+styal",
    ].join("\n");
    assert.deepStrictEqual(
      [...addedLineNumbers(diff)].map(([path, lines]) => [path, [...lines]]),
      [
        ["a.ts", [4, 5, 12]],
        ["docs/user/b.md", [1]],
      ],
    );
  });
});

describe("ledgerFeaturesByPath", () => {
  it("maps implementation and upstream paths to the entries that list them", () => {
    const ledger = [
      "features:",
      "  - id: first",
      "    invariants:",
      "      - Not a path.",
      "    implementation_paths:",
      "      - apps/web/src/a.ts",
      "    upstream_paths:",
      "      - apps/server/src/b.ts",
      "    tests:",
      "      - apps/web/src/a.test.ts",
      "  - id: second",
      "    implementation_paths:",
      "      - apps/web/src/a.ts",
    ].join("\n");
    const byPath = ledgerFeaturesByPath(ledger);
    assert.deepStrictEqual(byPath.get("apps/web/src/a.ts"), ["first", "second"]);
    assert.deepStrictEqual(byPath.get("apps/server/src/b.ts"), ["first"]);
    assert.isUndefined(byPath.get("apps/web/src/a.test.ts"));
  });
});

describe("summarizeSurvey", () => {
  it("counts each status and lists only the commits that need a person", () => {
    const summary = summarizeSurvey([
      {
        sha: "a".repeat(40),
        pr: 1,
        title: "fix: one",
        status: "clean",
        reasons: [],
        features: [],
        laterFixes: [],
      },
      {
        sha: "b".repeat(40),
        pr: 2,
        title: "feat: two",
        status: "needs-person",
        reasons: ["unresolved conflict: apps/web/src/a.ts"],
        features: ["first"],
        laterFixes: [],
      },
    ]);
    assert.strictEqual(
      summary,
      [
        "Surveyed 2 commits: 1 clean, 0 resolved, 1 need a person.",
        "",
        "bbbbbbbbbb #2 feat: two",
        "    unresolved conflict: apps/web/src/a.ts",
        "    fork features: first",
        "",
      ].join("\n"),
    );
  });

  it("lists later fixes under the commit they name, with the evidence and any tracking", () => {
    const summary = summarizeSurvey([
      {
        sha: "a".repeat(40),
        pr: 1,
        title: "fix: one",
        status: "clean",
        reasons: [],
        features: [],
        laterFixes: [
          { sha: "c".repeat(40), pr: 3, title: "fix: one again (#3)", evidence: "Since #1, x." },
          {
            sha: "d".repeat(40),
            pr: 4,
            title: "fix: more (#4)",
            evidence: "After #1, y.",
            tracked: "Ported by fork #9.",
          },
        ],
      },
    ]);
    assert.strictEqual(
      summary,
      [
        "Surveyed 1 commits: 1 clean, 0 resolved, 0 need a person.",
        "",
        "Later upstream fixes name these commits; extend the batch, import the fix early, or port it before landing:",
        "",
        "aaaaaaaaaa #1 fix: one",
        "    cccccccccc #3 fix: one again (#3)",
        '        "Since #1, x."',
        "    dddddddddd #4 fix: more (#4)",
        '        "After #1, y."',
        "        tracked: Ported by fork #9.",
        "",
      ].join("\n"),
    );
  });
});

describe("touchesNativeFingerprint", () => {
  it("counts the mobile fingerprint check's inputs, including the root lockfile", () => {
    assert.isTrue(touchesNativeFingerprint(["apps/web/src/a.ts", "pnpm-lock.yaml"]));
    assert.isTrue(touchesNativeFingerprint(["packages/shared/src/path.ts"]));
    assert.isTrue(touchesNativeFingerprint(["apps/mobile/app.config.ts"]));
    assert.isFalse(touchesNativeFingerprint(["apps/web/package.json", "apps/server/src/ws.ts"]));
    assert.isFalse(touchesNativeFingerprint(["docs/user/mobile.md"]));
  });
});

describe("describeNativeFingerprint", () => {
  it("says when a batch keeps OTA updates reaching installed builds", () => {
    assert.match(describeNativeFingerprint("inputs unchanged"), /reach the same builds/u);
    assert.match(
      describeNativeFingerprint([
        { platform: "ios", base: "a".repeat(40), head: "a".repeat(40) },
        { platform: "android", base: "b".repeat(40), head: "b".repeat(40) },
      ]),
      /unchanged on iOS and Android/u,
    );
  });

  it("names the platforms whose fingerprint moved and the build they need", () => {
    const description = describeNativeFingerprint([
      { platform: "ios", base: "a".repeat(40), head: "c".repeat(40) },
      { platform: "android", base: "b".repeat(40), head: "b".repeat(40) },
    ]);
    assert.match(description, /moved on iOS \(aaaaaaaaaa → cccccccccc\)/u);
    assert.match(description, /installed iOS apps/u);
    assert.match(description, /production builds Mobile EAS Production starts/u);
    assert.notInclude(description, "Android");
  });

  it("asks for a manual comparison when the fingerprint could not be computed", () => {
    assert.match(
      describeNativeFingerprint({ error: "base install failed" }),
      /not compared \(base install failed\)/u,
    );
  });
});

describe("newestAndroidReleaseTag", () => {
  it("picks the highest versionCode, not the last or highest version", () => {
    const lsRemote = [
      `${"a".repeat(40)}\trefs/tags/android-2.2.0-24`,
      `${"b".repeat(40)}\trefs/tags/android-10.0.0-9`,
      `${"c".repeat(40)}\trefs/tags/android-2.1.0-23`,
      `${"d".repeat(40)}\trefs/tags/android-2.2.0-24^{}`,
      `${"e".repeat(40)}\trefs/tags/v2.2.0`,
    ].join("\n");
    assert.strictEqual(newestAndroidReleaseTag(lsRemote), "android-2.2.0-24");
    assert.isUndefined(newestAndroidReleaseTag(""));
  });
});

describe("describeShippedNativeRuntime", () => {
  const shipped = { tag: "android-2.2.0-24", runtimeVersion: "a".repeat(40) };

  it("says OTA updates reach installed apps when the batch matches the release", () => {
    assert.match(describeShippedNativeRuntime(shipped, "a".repeat(40)), /reach the latest/u);
  });

  it("says OTA updates wait for new builds when main no longer matches the release", () => {
    const description = describeShippedNativeRuntime(shipped, "b".repeat(40));
    assert.match(description, /\(bbbbbbbbbb\) differs from android-2\.2\.0-24's \(aaaaaaaaaa\)/u);
    assert.match(description, /even if this batch did not move it/u);
    assert.match(description, /until Mobile EAS Production finishes the builds/u);
  });

  it("asks for a manual comparison when either side is missing", () => {
    assert.match(
      describeShippedNativeRuntime({ error: "no Android release found" }, "a".repeat(40)),
      /not compared \(no Android release found\)/u,
    );
    assert.match(
      describeShippedNativeRuntime(shipped, { error: "android fingerprint failed" }),
      /not compared \(android fingerprint failed\)\. Compare main with android-2\.2\.0-24/u,
    );
  });
});

describe("nativeFingerprintVerdict", () => {
  it("is unchanged only when no input changed or every platform kept its hash", () => {
    assert.equal(nativeFingerprintVerdict("inputs unchanged"), "unchanged");
    assert.equal(
      nativeFingerprintVerdict([{ platform: "ios", base: "a".repeat(40), head: "a".repeat(40) }]),
      "unchanged",
    );
    assert.equal(
      nativeFingerprintVerdict([
        { platform: "ios", base: "a".repeat(40), head: "a".repeat(40) },
        { platform: "android", base: "b".repeat(40), head: "c".repeat(40) },
      ]),
      "moved",
    );
    assert.equal(nativeFingerprintVerdict({ error: "base install failed" }), "unknown");
  });
});

describe("patchOverridePins", () => {
  const fork = [
    "catalog:",
    "  yaml: 2.8.0",
    "",
    "overrides:",
    "  # Pin every patched package.",
    "  expo-audio: 58.0.9",
    '  "@pierre/diffs": 1.5.2',
    '  vite: "catalog:"',
    "",
    "patchedDependencies:",
    "  expo-audio@58.0.9: patches/expo-audio@58.0.9.patch",
    "",
  ].join("\n");
  const upstream = (...patched: Array<string>) =>
    ["patchedDependencies:", ...patched.map((entry) => `  "${entry}": patches/x.patch`), ""].join(
      "\n",
    );

  it("pins a package upstream starts patching and moves a pin upstream bumps", () => {
    const pins = patchOverridePins({
      upstreamBefore: upstream("@pierre/diffs@1.5.2"),
      upstreamAfter: upstream("@pierre/diffs@1.6.0", "expo-network@58.0.3"),
      fork,
    });
    assert.deepStrictEqual(pins, [
      { name: "@pierre/diffs", version: "1.6.0", previous: "1.5.2" },
      { name: "expo-network", version: "58.0.3", previous: null },
    ]);
    assert.strictEqual(
      applyOverridePins(fork, pins),
      [
        "catalog:",
        "  yaml: 2.8.0",
        "",
        "overrides:",
        "  # Pin every patched package.",
        "  expo-audio: 58.0.9",
        '  "@pierre/diffs": 1.6.0',
        '  vite: "catalog:"',
        "  expo-network: 58.0.3",
        "",
        "patchedDependencies:",
        "  expo-audio@58.0.9: patches/expo-audio@58.0.9.patch",
        "",
      ].join("\n"),
    );
  });

  it("leaves patches it already pins, catalog pins, and existing patches alone", () => {
    assert.deepStrictEqual(
      patchOverridePins({
        upstreamBefore: upstream("dbus-next@0.10.2"),
        upstreamAfter: upstream(
          "dbus-next@0.10.2",
          "expo-audio@58.0.9",
          "vite@8.0.0",
          "yaml@2.8.0",
        ),
        fork,
      }),
      [],
    );
  });

  it("reads a commit without a workspace file as patching nothing", () => {
    assert.deepStrictEqual(
      patchOverridePins({ upstreamBefore: "", upstreamAfter: upstream("a@1.0.0"), fork }),
      [{ name: "a", version: "1.0.0", previous: null }],
    );
  });
});

describe("draftAdaptationNote patch pins", () => {
  it("explains the override pin", () => {
    assert.strictEqual(
      draftAdaptationNote([
        { kind: "patch-pins", path: "pnpm-workspace.yaml", detail: "expo-network@58.0.3" },
      ]).note,
      "`pnpm-workspace.yaml` pins the newly patched expo-network@58.0.3 in `overrides`, as the fork pins every patched package so lockfile-free installs keep the patch.",
    );
  });
});

describe("queuedAutoMerges", () => {
  const pullRequest = (
    number: number,
    overrides: Partial<Parameters<typeof queuedAutoMerges>[0][number]> = {},
  ) => ({
    number,
    title: `PR ${number}`,
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    autoMergeRequest: { enabledAt: "2026-10-29T00:00:00Z" },
    statusCheckRollup: [{ name: "Fork CI", conclusion: "SUCCESS" }],
    ...overrides,
  });

  it("lists auto-merge pull requests that can still land on their own", () => {
    const queued = queuedAutoMerges([
      pullRequest(1),
      pullRequest(2, { statusCheckRollup: [{ name: "Fork CI", conclusion: null }] }),
      pullRequest(3, {
        statusCheckRollup: [{ context: "Intake landing hold", state: "SUCCESS" }],
      }),
    ]);
    assert.deepStrictEqual(
      queued.map((entry) => entry.number),
      [1, 2, 3],
    );
  });

  it("skips pull requests that will not land before the batch", () => {
    const queued = queuedAutoMerges([
      pullRequest(1, { autoMergeRequest: null }),
      pullRequest(2, { isDraft: true }),
      pullRequest(3, { mergeable: "CONFLICTING" }),
      pullRequest(4, { reviewDecision: "CHANGES_REQUESTED" }),
      pullRequest(5, { statusCheckRollup: [{ name: "Fork CI", conclusion: "FAILURE" }] }),
      pullRequest(6, {
        statusCheckRollup: [{ context: "Intake landing hold", state: "PENDING" }],
      }),
    ]);
    assert.deepStrictEqual(queued, []);
  });
});

describe("summarizeSurvey lint changes", () => {
  it("lists the commits that change lint rules", () => {
    const summary = summarizeSurvey([
      {
        sha: "a".repeat(40),
        pr: 1,
        title: "chore: add prefer-effect-fn",
        status: "clean",
        reasons: [],
        features: [],
        laterFixes: [],
        changesLint: true,
      },
    ]);
    assert.strictEqual(
      summary,
      [
        "Surveyed 1 commits: 1 clean, 0 resolved, 0 need a person.",
        "",
        "These change lint rules or their configuration; lint the whole repository on the clean picks before assembly, and give fork-code violations their own track:",
        "  aaaaaaaaaa #1 chore: add prefer-effect-fn",
        "",
      ].join("\n"),
    );
  });
});
