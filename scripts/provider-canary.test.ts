// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  CANARY_PROVIDERS,
  MANIFEST_PATH,
  addAutoUpdate,
  autoMergeBlocker,
  collectRun,
  planProvider,
  reconcileStatusIssue,
  recordVersions,
  statusFailures,
  styalBuildContains,
  type CanaryFailure,
  type CanaryOutcome,
  type CanaryProvider,
  type PlanOutput,
} from "./provider-canary.ts";

const NIGHTLY = "0.1.1-nightly.20261014.700";
const LATER_NIGHTLY = "0.1.1-nightly.20261015.730";

const MANIFEST_TEXT = `{
  "version": 1,
  "updatedAt": "2026-10-11T20:00:00.000Z",
  "compatibility": [
    {
      "driver": "codex",
      "t3CodeRange": ">=0.1.0",
      "recommendedRange": ">=0.159.0",
      "ranges": [
        { "range": ">=0.156.0", "status": "supported" },
        { "range": "<0.156.0", "status": "broken" }
      ]
    },
    {
      "driver": "codex",
      "t3CodeRange": ">=0.0.42 <0.1.0",
      "autoUpdates": [
        {
          "version": "0.157.0",
          "package": "@openai/codex",
          "styal": "0.0.45"
        }
      ],
      "ranges": [{ "range": ">=0.156.0", "status": "supported" }]
    },
    {
      "driver": "opencode",
      "t3CodeRange": ">=0.0.42",
      "autoUpdates": [
        {
          "version": "2.0.20",
          "package": "@opencode/cli",
          "styal": "${NIGHTLY}"
        }
      ],
      "ranges": [
        { "range": ">=2.0.18", "status": "supported" },
        { "range": ">=1.14.19 <2.0.0", "status": "graceful" }
      ]
    }
  ],
  "providers": {}
}
`;
const manifest = JSON.parse(MANIFEST_TEXT);
const canary = (provider: string) => CANARY_PROVIDERS.find((entry) => entry.provider === provider)!;
const NOW = new Date("2026-10-14T12:00:00.000Z");
const codexEntry = (version: string, styal: string) => ({
  provider: "codex",
  packageName: "@openai/codex",
  version,
  styal,
});

describe("provider canary plan", () => {
  it("verifies a supported release the build may not install yet", () => {
    expect(
      planProvider(canary("codex"), manifest, NIGHTLY, { "@openai/codex": "0.158.0" }),
    ).toEqual({
      kind: "verify",
      provider: "codex",
      entry: {
        provider: "codex",
        packageName: "@openai/codex",
        binary: "codex",
        version: "0.158.0",
        model: canary("codex").model,
        secret: "OPENAI_API_KEY",
        styal: NIGHTLY,
      },
    });
  });

  it("skips a release already verified for builds the tested one contains, unless forced", () => {
    const latest = { "@opencode/cli": "2.0.20" };
    expect(planProvider(canary("opencode"), manifest, LATER_NIGHTLY, latest).kind).toBe("current");
    expect(planProvider(canary("opencode"), manifest, LATER_NIGHTLY, latest, true).kind).toBe(
      "verify",
    );
  });

  it("verifies again on a build that does not contain the verified one", () => {
    const latest = { "@opencode/cli": "2.0.20" };
    // Stable 0.1.1 may be rebuilt from a nightly older than the verified one.
    expect(planProvider(canary("opencode"), manifest, "0.1.1", latest).kind).toBe("verify");
    expect(planProvider(canary("opencode"), manifest, "0.1.2", latest).kind).toBe("current");
  });

  it("blocks a release outside the supported ranges, even when forced", () => {
    const plan = planProvider(
      canary("codex"),
      manifest,
      NIGHTLY,
      { "@openai/codex": "0.150.0" },
      true,
    );
    expect(plan).toMatchObject({ kind: "blocked", provider: "codex" });
    expect(plan.kind === "blocked" && plan.reason).toContain("@openai/codex@0.150.0 is broken");
  });

  it("blocks a provider without an applicable policy", () => {
    const plan = planProvider(canary("claudeAgent"), manifest, NIGHTLY, {
      "@anthropic-ai/claude-code": "2.1.300",
    });
    expect(plan.kind).toBe("blocked");
  });

  it("picks the OpenCode package whose release is supported", () => {
    const plan = planProvider(canary("opencode"), manifest, NIGHTLY, {
      "opencode-ai": "1.15.0",
      "@opencode/cli": "2.0.21",
    });
    expect(plan).toMatchObject({
      kind: "verify",
      entry: { packageName: "@opencode/cli", version: "2.0.21" },
    });
  });

  it("ignores prerelease tags", () => {
    const plan = planProvider(canary("codex"), manifest, NIGHTLY, {
      "@openai/codex": "0.170.0-alpha.1",
    });
    expect(plan.kind).toBe("blocked");
  });

  it("holds a release that failed on the same build for six hours, unless forced", () => {
    const latest = { "@openai/codex": "0.158.0" };
    const failure: CanaryFailure = {
      provider: "codex",
      packageName: "@openai/codex",
      version: "0.158.0",
      styal: NIGHTLY,
      detail: "rewind failed",
      at: "2026-10-14T08:00:00.000Z",
    };
    const plan = (build: string, now: Date, force = false) =>
      planProvider(canary("codex"), manifest, build, latest, force, [failure], now).kind;
    expect(plan(NIGHTLY, NOW)).toBe("held");
    expect(plan(NIGHTLY, NOW, true)).toBe("verify");
    // A new nightly may carry the fix, so it is verified at once.
    expect(plan(LATER_NIGHTLY, NOW)).toBe("verify");
    expect(plan(NIGHTLY, new Date("2026-10-14T14:00:00.000Z"))).toBe("verify");
    expect(
      planProvider(canary("codex"), manifest, NIGHTLY, { "@openai/codex": "0.158.1" }, false, [
        failure,
      ]).kind,
    ).toBe("verify");
  });

  it("matches the server's rule for which builds contain a verified build", () => {
    expect(styalBuildContains(LATER_NIGHTLY, NIGHTLY)).toBe(true);
    expect(styalBuildContains("0.1.1", NIGHTLY)).toBe(false);
    expect(styalBuildContains("0.1.2", NIGHTLY)).toBe(true);
    expect(styalBuildContains("0.1.2-nightly.20261020.760", "0.1.1")).toBe(true);
  });

  it("uses default models from the bundled manifest's current catalogs", () => {
    const bundled = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8"));
    for (const entry of CANARY_PROVIDERS.filter((item) => item.provider !== "opencode")) {
      expect(bundled.currentModels[entry.provider]).toContain(entry.model);
    }
    const opencode: CanaryProvider = canary("opencode");
    // OpenRouter names Claude versions with dots: claude-haiku-5.5 is claude-haiku-5-5.
    const claudeModel = opencode.model.replace(/^openrouter\/anthropic\//, "").replaceAll(".", "-");
    expect(bundled.currentModels.claudeAgent).toContain(claudeModel);
  });
});

describe("provider canary record", () => {
  it("adds an entry before ranges and bumps updatedAt, leaving other policies untouched", () => {
    const next = recordVersions(MANIFEST_TEXT, [codexEntry("0.158.0", NIGHTLY)], NOW);
    expect(next).toBe(
      MANIFEST_TEXT.replace("2026-10-11T20:00:00.000Z", NOW.toISOString()).replace(
        `"recommendedRange": ">=0.159.0",\n`,
        `"recommendedRange": ">=0.159.0",\n      "autoUpdates": [\n        {\n          "version": "0.158.0",\n          "package": "@openai/codex",\n          "styal": "${NIGHTLY}"\n        }\n      ],\n`,
      ),
    );
  });

  it("keeps entries for older builds and drops ones a new entry covers", () => {
    const opencode = (version: string, styal: string) => ({
      provider: "opencode",
      packageName: "@opencode/cli",
      version,
      styal,
    });
    const later = JSON.parse(
      recordVersions(MANIFEST_TEXT, [opencode("2.0.21", LATER_NIGHTLY)], NOW),
    );
    expect(later.compatibility[2].autoUpdates).toEqual([
      { version: "2.0.20", package: "@opencode/cli", styal: NIGHTLY },
      { version: "2.0.21", package: "@opencode/cli", styal: LATER_NIGHTLY },
    ]);
    const covering = JSON.parse(recordVersions(MANIFEST_TEXT, [opencode("2.0.21", NIGHTLY)], NOW));
    expect(covering.compatibility[2].autoUpdates).toEqual([
      { version: "2.0.21", package: "@opencode/cli", styal: NIGHTLY },
    ]);
    // An older version on an older build covers builds the nightly entry does not.
    const stable = JSON.parse(recordVersions(MANIFEST_TEXT, [opencode("2.0.19", "0.1.0")], NOW));
    expect(stable.compatibility[2].autoUpdates).toHaveLength(2);
  });

  it("returns the text unchanged when the entry adds nothing", () => {
    expect(
      recordVersions(
        MANIFEST_TEXT,
        [
          {
            provider: "opencode",
            packageName: "@opencode/cli",
            version: "2.0.20",
            styal: LATER_NIGHTLY,
          },
        ],
        NOW,
      ),
    ).toBe(MANIFEST_TEXT);
  });

  it("carries the open pull request's additions over, but not entries withdrawn from main", () => {
    const pending = JSON.parse(
      recordVersions(MANIFEST_TEXT, [codexEntry("0.158.0", NIGHTLY)], NOW),
    );
    // Main withdrew the OpenCode entry after the pull request branched.
    const withdrawn = JSON.parse(MANIFEST_TEXT);
    withdrawn.compatibility[2].autoUpdates = [];
    withdrawn.updatedAt = "2026-10-14T18:00:00.000Z";
    const parsed = JSON.parse(
      recordVersions(
        `${JSON.stringify(withdrawn, null, 2)}\n`,
        [],
        new Date("2026-10-15T12:00:00.000Z"),
        { pending, base: manifest },
      ),
    );
    expect(parsed.compatibility[0].autoUpdates).toEqual([
      { version: "0.158.0", package: "@openai/codex", styal: NIGHTLY },
    ]);
    expect(parsed.compatibility[2].autoUpdates).toEqual([]);
  });

  it("keeps at most three entries per package and channel", () => {
    const policy = structuredClone(manifest.compatibility[2]);
    for (const [index, version] of ["2.0.21", "2.0.22", "2.0.23"].entries()) {
      policy.autoUpdates = addAutoUpdate(policy, {
        version,
        package: "@opencode/cli",
        styal: `0.1.1-nightly.2026101${5 + index}.${731 + index}`,
      });
    }
    expect(policy.autoUpdates.map((entry: { version: string }) => entry.version)).toEqual([
      "2.0.21",
      "2.0.22",
      "2.0.23",
    ]);
  });

  it("refuses versions outside a supported range", () => {
    expect(() =>
      recordVersions(
        MANIFEST_TEXT,
        [{ provider: "opencode", packageName: "opencode-ai", version: "1.15.0", styal: NIGHTLY }],
        NOW,
      ),
    ).toThrow("graceful");
  });

  it("refuses an updatedAt that does not move forward", () => {
    expect(() =>
      recordVersions(
        MANIFEST_TEXT,
        [codexEntry("0.158.0", NIGHTLY)],
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).toThrow("not newer");
  });

  it("edits the bundled manifest consistently", () => {
    const text = NodeFS.readFileSync(MANIFEST_PATH, "utf8");
    const bundled = JSON.parse(text);
    const policy = bundled.compatibility.find(
      (entry: { driver: string }) => entry.driver === "claudeAgent",
    );
    const supported = policy.ranges.find(
      (range: { status: string }) => range.status === "supported",
    );
    const version = supported.range.replace(/^>=/, "");
    const next = recordVersions(
      text,
      [
        {
          provider: "claudeAgent",
          packageName: "@anthropic-ai/claude-code",
          version,
          styal: LATER_NIGHTLY,
        },
      ],
      new Date(Date.parse(bundled.updatedAt) + 1000),
    );
    expect(next.endsWith("}\n")).toBe(true);
    // Only autoUpdates arrays and updatedAt change; the rest of the file keeps its layout.
    const layout = (manifestText: string) =>
      manifestText
        .replace(/\n\s*"autoUpdates": \[[\s\S]*?\n\s*\],/g, "")
        .replace(/"updatedAt": "[^"]*"/, "");
    expect(layout(next)).toBe(layout(text));
    expect(next).not.toBe(text);
  });
});

describe("provider canary report", () => {
  const RUN = "https://github.com/incognitojam/styal/actions/runs/1";
  const LATER_RUN = "https://github.com/incognitojam/styal/actions/runs/2";
  const verifyPlan = (provider: string, packageName: string, version: string) => ({
    kind: "verify" as const,
    provider,
    styal: NIGHTLY,
    entry: {
      provider,
      packageName,
      binary: provider,
      version,
      model: "m",
      secret: "S",
      styal: NIGHTLY,
    },
  });
  const outcome = (
    provider: string,
    packageName: string,
    version: string,
    result: CanaryOutcome["outcome"],
    detail = "",
  ): CanaryOutcome => ({ provider, packageName, version, styal: NIGHTLY, outcome: result, detail });
  const runWith = (plans: PlanOutput["plans"], outcomes: Array<CanaryOutcome>) =>
    collectRun({ plan: { plans }, outcomes, planResult: "success", recordResult: "skipped" });

  const codexFails = (version: string) =>
    runWith(
      [verifyPlan("codex", "@openai/codex", version)],
      [outcome("codex", "@openai/codex", version, "failed", "rewind: rollback method not found")],
    );

  it("opens the issue on the first problem, without a separate comment", () => {
    const update = reconcileStatusIssue(null, codexFails("0.163.0"), [], RUN);
    expect(update).toMatchObject({ state: "open" });
    expect(update?.comment).toBeUndefined();
    expect(update?.body).toContain("@openai/codex@0.163.0** on styal");
  });

  it("does not comment again while the same provider keeps failing on new releases", () => {
    const opened = reconcileStatusIssue(null, codexFails("0.163.0"), [], RUN)!;
    const issue = { number: 5, open: true, body: opened.body };
    const next = reconcileStatusIssue(issue, codexFails("0.164.0"), [], LATER_RUN);
    expect(next?.comment).toBeUndefined();
    expect(next?.body).toContain("0.164.0");
  });

  it("comments for a problem with another provider", () => {
    const opened = reconcileStatusIssue(null, codexFails("0.163.0"), [], RUN)!;
    const issue = { number: 5, open: true, body: opened.body };
    const run = runWith(
      [
        verifyPlan("codex", "@openai/codex", "0.163.0"),
        { kind: "blocked", provider: "opencode", styal: NIGHTLY, reason: "No supported release." },
      ],
      [outcome("codex", "@openai/codex", "0.163.0", "failed", "rewind failed")],
    );
    const update = reconcileStatusIssue(issue, run, [], LATER_RUN);
    expect(update?.comment).toContain("**opencode** on styal");
    expect(update?.comment).not.toContain("codex");
  });

  it("keeps problems for providers this run did not check", () => {
    const opened = reconcileStatusIssue(null, codexFails("0.163.0"), [], RUN)!;
    const issue = { number: 5, open: true, body: opened.body };
    // A Claude-only dispatch passes; the Codex failure stands.
    const claudeOnly = runWith(
      [{ kind: "current", provider: "claudeAgent", styal: NIGHTLY, reason: "verified" }],
      [],
    );
    expect(reconcileStatusIssue(issue, claudeOnly, [], LATER_RUN)).toMatchObject({ state: "open" });
    // A failed plan checks nothing and adds its own problem.
    const planFailed = collectRun({
      plan: undefined,
      outcomes: [],
      planResult: "failure",
      recordResult: "skipped",
    });
    const update = reconcileStatusIssue(issue, planFailed, [], LATER_RUN);
    expect(update?.body).toContain("0.163.0");
    expect(update?.comment).toContain("The **plan** job failed.");
  });

  it("reports a missing verification result as a failure", () => {
    const run = runWith([verifyPlan("codex", "@openai/codex", "0.163.0")], []);
    expect(run.problems).toEqual([
      expect.objectContaining({
        key: "failed:codex",
        summary: expect.stringContaining("no verification result"),
      }),
    ]);
  });

  it("closes once every checked provider passes, and reopens on a new problem", () => {
    const opened = reconcileStatusIssue(null, codexFails("0.163.0"), [], RUN)!;
    const passing = runWith(
      [verifyPlan("codex", "@openai/codex", "0.164.0")],
      [outcome("codex", "@openai/codex", "0.164.0", "passed")],
    );
    const closing = reconcileStatusIssue(
      { number: 5, open: true, body: opened.body },
      passing,
      [],
      LATER_RUN,
    );
    expect(closing).toMatchObject({ state: "closed" });
    expect(closing?.comment).toContain("Every check passed");
    expect(reconcileStatusIssue(null, passing, [], LATER_RUN)).toBeNull();

    const reopened = reconcileStatusIssue(
      { number: 5, open: false, body: closing!.body },
      codexFails("0.165.0"),
      [],
      RUN,
    );
    expect(reopened).toMatchObject({ state: "open" });
    expect(reopened?.comment).toContain("0.165.0");
  });

  it("keeps a failed verification held across runs without commenting again", () => {
    const failed = collectRun({
      plan: { plans: [verifyPlan("codex", "@openai/codex", "0.163.0")] },
      outcomes: [outcome("codex", "@openai/codex", "0.163.0", "failed", "rewind failed")],
      planResult: "success",
      recordResult: "skipped",
      now: NOW,
    });
    const opened = reconcileStatusIssue(null, failed, [], RUN)!;
    const issue = { number: 5, open: true, body: opened.body };
    const [failure] = statusFailures(issue);
    expect(failure).toMatchObject({ version: "0.163.0", styal: NIGHTLY, at: NOW.toISOString() });

    const { entry } = verifyPlan("codex", "@openai/codex", "0.163.0");
    const held = runWith(
      [{ kind: "held", provider: "codex", styal: NIGHTLY, entry, failure: failure! }],
      [],
    );
    const update = reconcileStatusIssue(issue, held, [], LATER_RUN);
    expect(update).toMatchObject({ state: "open" });
    expect(update?.comment).toBeUndefined();
    expect(statusFailures({ ...issue, body: update!.body })).toEqual([failure]);

    // A pass on a later run clears the failure with the problem.
    const passing = runWith(
      [verifyPlan("codex", "@openai/codex", "0.164.0")],
      [outcome("codex", "@openai/codex", "0.164.0", "passed")],
    );
    expect(reconcileStatusIssue(issue, passing, [], LATER_RUN)?.body).not.toContain("failures");
  });

  it("lists passes on retry and missing credentials", () => {
    const run = runWith(
      [verifyPlan("claudeAgent", "@anthropic-ai/claude-code", "2.1.301")],
      [
        outcome(
          "claudeAgent",
          "@anthropic-ai/claude-code",
          "2.1.301",
          "skipped",
          "The ANTHROPIC_API_KEY secret is not set.",
        ),
      ],
    );
    expect(run.problems.map((problem) => problem.key)).toEqual(["skipped:claudeAgent"]);
    const update = reconcileStatusIssue(
      null,
      run,
      ["@openai/codex@0.163.0: interrupt timed out"],
      RUN,
    );
    expect(update?.body).toContain("Passed on retry:");
  });
});

describe("provider canary merge guard", () => {
  const opencode = (version: string, styal: string) => ({
    provider: "opencode",
    packageName: "@opencode/cli",
    version,
    styal,
  });

  it("allows what recording verified versions produces, including pruned entries", () => {
    const next = recordVersions(
      MANIFEST_TEXT,
      [codexEntry("0.158.0", NIGHTLY), opencode("2.0.21", NIGHTLY)],
      NOW,
    );
    expect(autoMergeBlocker(MANIFEST_TEXT, next)).toBeUndefined();
  });

  it("allows the open pull request's additions carried onto a newer main", () => {
    const pending = recordVersions(MANIFEST_TEXT, [codexEntry("0.158.0", NIGHTLY)], NOW);
    const next = recordVersions(
      MANIFEST_TEXT,
      [opencode("2.0.21", LATER_NIGHTLY)],
      new Date("2026-10-15T12:00:00.000Z"),
      { pending: JSON.parse(pending), base: manifest },
    );
    expect(autoMergeBlocker(MANIFEST_TEXT, next)).toBeUndefined();
  });

  it("blocks changes outside autoUpdates", () => {
    const next = recordVersions(MANIFEST_TEXT, [codexEntry("0.158.0", NIGHTLY)], NOW).replace(
      '">=0.156.0", "status": "supported"',
      '">=0.150.0", "status": "supported"',
    );
    expect(autoMergeBlocker(MANIFEST_TEXT, next)).toContain("outside `autoUpdates`");
  });

  it("blocks removed entries, foreign packages and a stale updatedAt", () => {
    const edited = (edit: (draft: typeof manifest) => void) => {
      const draft = structuredClone(manifest);
      draft.updatedAt = NOW.toISOString();
      edit(draft);
      return JSON.stringify(draft);
    };
    expect(
      autoMergeBlocker(
        MANIFEST_TEXT,
        edited((draft) => {
          draft.compatibility[2].autoUpdates = [];
        }),
      ),
    ).toContain("changes more than recording");
    expect(
      autoMergeBlocker(
        MANIFEST_TEXT,
        edited((draft) => {
          draft.compatibility[0].autoUpdates = [
            { version: "0.158.0", package: "evil-codex", styal: NIGHTLY },
          ];
        }),
      ),
    ).toContain("not one the canary records");
    expect(
      autoMergeBlocker(
        MANIFEST_TEXT,
        edited((draft) => {
          draft.updatedAt = manifest.updatedAt;
          draft.compatibility[0].autoUpdates = [
            { version: "0.158.0", package: "@openai/codex", styal: NIGHTLY },
          ];
        }),
      ),
    ).toContain("does not move forward");
  });
});
