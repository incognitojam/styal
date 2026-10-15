// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  CANARY_PROVIDERS,
  MANIFEST_PATH,
  addAutoUpdate,
  collectProblems,
  planProvider,
  reconcileStatusIssue,
  recordVersions,
  type CanaryProvider,
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
        {
          "range": ">=0.156.0",
          "status": "supported"
        },
        {
          "range": "<0.156.0",
          "status": "broken"
        }
      ]
    },
    {
      "driver": "codex",
      "t3CodeRange": ">=0.0.42 <0.1.0",
      "autoUpdates": [
        {
          "version": "0.157.0",
          "package": "@openai/codex",
          "after": "0.0.45"
        }
      ],
      "ranges": [
        {
          "range": ">=0.156.0",
          "status": "supported"
        }
      ]
    },
    {
      "driver": "opencode",
      "t3CodeRange": ">=0.0.42",
      "autoUpdates": [
        {
          "version": "2.0.20",
          "package": "@opencode/cli",
          "after": "${NIGHTLY}"
        }
      ],
      "ranges": [
        {
          "range": ">=2.0.18",
          "status": "supported"
        },
        {
          "range": ">=1.14.19 <2.0.0",
          "status": "graceful"
        }
      ]
    }
  ],
  "providers": {}
}
`;
const manifest = JSON.parse(MANIFEST_TEXT);
const canary = (provider: string) => CANARY_PROVIDERS.find((entry) => entry.provider === provider)!;
const NOW = new Date("2026-10-14T12:00:00.000Z");

describe("provider canary plan", () => {
  it("verifies a supported release newer than the recorded version", () => {
    expect(
      planProvider(canary("codex"), manifest, "0.0.46", { "@openai/codex": "0.158.0" }),
    ).toEqual({
      kind: "verify",
      entry: {
        provider: "codex",
        packageName: "@openai/codex",
        binary: "codex",
        version: "0.158.0",
        model: canary("codex").model,
        secret: "OPENAI_API_KEY",
      },
    });
  });

  it("skips a release that is already verified unless forced", () => {
    const latest = { "@openai/codex": "0.157.0" };
    expect(planProvider(canary("codex"), manifest, "0.0.46", latest).kind).toBe("current");
    expect(planProvider(canary("codex"), manifest, "0.0.46", latest, true).kind).toBe("verify");
  });

  it("verifies again for servers that the recorded entry does not cover", () => {
    // The entry applies to servers after 0.0.45; one recorded for older code
    // says nothing about builds before it.
    const latest = { "@openai/codex": "0.157.0" };
    expect(planProvider(canary("codex"), manifest, "0.0.44", latest).kind).toBe("verify");
  });

  it("verifies when the policy has no recorded version", () => {
    const plan = planProvider(canary("codex"), manifest, NIGHTLY, { "@openai/codex": "0.157.0" });
    expect(plan.kind).toBe("verify");
  });

  it("blocks a release outside the supported ranges, even when forced", () => {
    const plan = planProvider(
      canary("codex"),
      manifest,
      NIGHTLY,
      { "@openai/codex": "0.150.0" },
      true,
    );
    expect(plan).toMatchObject({
      kind: "blocked",
      provider: "codex",
      releases: "@openai/codex@0.150.0",
    });
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

  it("uses default models from the bundled manifest's current catalogs", () => {
    const bundled = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8"));
    for (const entry of CANARY_PROVIDERS.filter((item) => item.provider !== "opencode")) {
      expect(bundled.currentModels[entry.provider]).toContain(entry.model);
    }
    const opencode: CanaryProvider = canary("opencode");
    expect(bundled.currentModels.claudeAgent).toContain(opencode.model.replace(/^anthropic\//, ""));
  });
});

describe("provider canary record", () => {
  it("adds an entry before ranges and bumps updatedAt, leaving other policies untouched", () => {
    const next = recordVersions(
      MANIFEST_TEXT,
      NIGHTLY,
      [{ provider: "codex", packageName: "@openai/codex", version: "0.158.0" }],
      NOW,
    );
    expect(next).toBe(
      MANIFEST_TEXT.replace("2026-10-11T20:00:00.000Z", NOW.toISOString()).replace(
        `"recommendedRange": ">=0.159.0",\n`,
        `"recommendedRange": ">=0.159.0",\n      "autoUpdates": [\n        {\n          "version": "0.158.0",\n          "package": "@openai/codex",\n          "after": "${NIGHTLY}"\n        }\n      ],\n`,
      ),
    );
  });

  it("keeps entries for older servers and drops ones a new entry covers", () => {
    const parsed = JSON.parse(
      recordVersions(
        MANIFEST_TEXT,
        LATER_NIGHTLY,
        [{ provider: "opencode", packageName: "@opencode/cli", version: "2.0.21" }],
        NOW,
      ),
    );
    expect(parsed.compatibility[2].autoUpdates).toEqual([
      { version: "2.0.20", package: "@opencode/cli", after: NIGHTLY },
      { version: "2.0.21", package: "@opencode/cli", after: LATER_NIGHTLY },
    ]);
    const covering = JSON.parse(
      recordVersions(
        MANIFEST_TEXT,
        NIGHTLY,
        [{ provider: "opencode", packageName: "@opencode/cli", version: "2.0.21" }],
        NOW,
      ),
    );
    expect(covering.compatibility[2].autoUpdates).toEqual([
      { version: "2.0.21", package: "@opencode/cli", after: NIGHTLY },
    ]);
  });

  it("returns the text unchanged when the entry adds nothing", () => {
    expect(
      recordVersions(
        MANIFEST_TEXT,
        LATER_NIGHTLY,
        [{ provider: "opencode", packageName: "@opencode/cli", version: "2.0.20" }],
        NOW,
      ),
    ).toBe(MANIFEST_TEXT);
  });

  it("carries entries over from an unmerged canary branch", () => {
    const pending = JSON.parse(
      recordVersions(
        MANIFEST_TEXT,
        NIGHTLY,
        [{ provider: "codex", packageName: "@openai/codex", version: "0.158.0" }],
        NOW,
      ),
    );
    // Today only OpenCode passed; yesterday's Codex result must survive.
    const parsed = JSON.parse(
      recordVersions(
        MANIFEST_TEXT,
        LATER_NIGHTLY,
        [{ provider: "opencode", packageName: "@opencode/cli", version: "2.0.21" }],
        new Date("2026-10-15T12:00:00.000Z"),
        pending,
      ),
    );
    expect(parsed.compatibility[0].autoUpdates).toEqual([
      { version: "0.158.0", package: "@openai/codex", after: NIGHTLY },
    ]);
    expect(parsed.compatibility[2].autoUpdates).toHaveLength(2);
  });

  it("keeps at most three entries per package", () => {
    const policy = structuredClone(manifest.compatibility[2]);
    for (const [index, version] of ["2.0.21", "2.0.22", "2.0.23"].entries()) {
      policy.autoUpdates = addAutoUpdate(policy, {
        version,
        package: "@opencode/cli",
        after: `0.1.1-nightly.2026101${5 + index}.${731 + index}`,
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
        NIGHTLY,
        [{ provider: "opencode", packageName: "opencode-ai", version: "1.15.0" }],
        NOW,
      ),
    ).toThrow("graceful");
  });

  it("refuses an updatedAt that does not move forward", () => {
    expect(() =>
      recordVersions(
        MANIFEST_TEXT,
        NIGHTLY,
        [{ provider: "codex", packageName: "@openai/codex", version: "0.158.0" }],
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
      LATER_NIGHTLY,
      [{ provider: "claudeAgent", packageName: "@anthropic-ai/claude-code", version }],
      new Date(Date.parse(bundled.updatedAt) + 1000),
    );
    expect(next.endsWith("}\n")).toBe(true);
    // Seven new lines for the autoUpdates array; the rest of the file keeps its layout.
    expect(next.split("\n").length).toBe(text.split("\n").length + 7);
  });
});

describe("provider canary report", () => {
  const RUN = "https://github.com/incognitojam/styal/actions/runs/1";
  const LATER_RUN = "https://github.com/incognitojam/styal/actions/runs/2";
  const failed = collectProblems({
    blocked: [],
    outcomes: [
      {
        provider: "codex",
        packageName: "@openai/codex",
        version: "0.163.0",
        outcome: "failed",
        detail: "rewind: rollback method not found",
      },
    ],
    failedJobs: [],
  });

  it("opens the issue on the first problem, without a separate comment", () => {
    const update = reconcileStatusIssue(null, failed, [], RUN);
    expect(update).toMatchObject({ state: "open" });
    expect(update?.comment).toBeUndefined();
    expect(update?.body).toContain("@openai/codex@0.163.0** failed verification twice");
  });

  it("comments only for problems the open issue does not list", () => {
    const opened = reconcileStatusIssue(null, failed, [], RUN)!;
    const issue = { number: 5, open: true, body: opened.body };
    expect(reconcileStatusIssue(issue, failed, [], LATER_RUN)?.comment).toBeUndefined();

    const blocked = collectProblems({
      blocked: [
        {
          provider: "opencode",
          releases: "@opencode/cli@3.0.0",
          reason: "No latest release is in a supported range.",
        },
      ],
      outcomes: [],
      failedJobs: [],
    });
    const update = reconcileStatusIssue(issue, [...failed, ...blocked], [], LATER_RUN);
    expect(update?.comment).toContain("**opencode** is not verified");
    expect(update?.comment).not.toContain("codex");
  });

  it("closes the issue with a comment once every problem clears, and reopens on a new one", () => {
    const opened = reconcileStatusIssue(null, failed, [], RUN)!;
    const closing = reconcileStatusIssue(
      { number: 5, open: true, body: opened.body },
      [],
      [],
      LATER_RUN,
    );
    expect(closing).toMatchObject({ state: "closed" });
    expect(closing?.comment).toContain("Every check passed");
    expect(reconcileStatusIssue(null, [], [], LATER_RUN)).toBeNull();

    const reopened = reconcileStatusIssue(
      { number: 5, open: false, body: closing!.body },
      failed,
      [],
      RUN,
    );
    expect(reopened).toMatchObject({ state: "open" });
    expect(reopened?.comment).toContain("0.163.0");
  });

  it("lists passes on retry and missing credentials", () => {
    const problems = collectProblems({
      blocked: [],
      outcomes: [
        {
          provider: "claudeAgent",
          packageName: "@anthropic-ai/claude-code",
          version: "2.1.301",
          outcome: "skipped",
          detail: "The ANTHROPIC_API_KEY secret is not set.",
        },
      ],
      failedJobs: ["record"],
    });
    expect(problems.map((problem) => problem.key)).toEqual(["job:record", "skipped:claudeAgent"]);
    const update = reconcileStatusIssue(
      null,
      problems,
      ["@openai/codex@0.163.0: interrupt timed out"],
      RUN,
    );
    expect(update?.body).toContain("Passed on retry:");
  });
});
