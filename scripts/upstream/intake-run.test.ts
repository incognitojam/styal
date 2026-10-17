import { assert, describe, it } from "@effect/vitest";

import {
  draftAdaptationNote,
  intakeCommitMessage,
  lockfilePackages,
  overrideSelector,
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
