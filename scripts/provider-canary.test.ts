// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  CANARY_PROVIDERS,
  MANIFEST_PATH,
  planProvider,
  recordVersions,
  type CanaryProvider,
} from "./provider-canary.ts";

const MANIFEST_TEXT = `{
  "version": 1,
  "updatedAt": "2026-10-11T20:00:00.000Z",
  "compatibility": [
    {
      "driver": "codex",
      "t3CodeRange": ">=0.0.44",
      "recommendedRange": ">=0.159.0",
      "ranges": [
        { "range": ">=0.156.0", "status": "supported" },
        { "range": "<0.156.0", "status": "broken" }
      ]
    },
    {
      "driver": "codex",
      "t3CodeRange": ">=0.0.42 <0.0.44",
      "autoUpdateVersion": "0.157.0",
      "ranges": [{ "range": ">=0.156.0", "status": "supported" }]
    },
    {
      "driver": "opencode",
      "t3CodeRange": ">=0.0.42",
      "autoUpdateVersion": "2.0.20",
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

describe("provider canary plan", () => {
  it("verifies a supported release newer than the recorded version", () => {
    expect(
      planProvider(canary("codex"), manifest, "0.0.43", { "@openai/codex": "0.158.0" }),
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
    expect(planProvider(canary("codex"), manifest, "0.0.43", latest).kind).toBe("current");
    expect(planProvider(canary("codex"), manifest, "0.0.43", latest, true).kind).toBe("verify");
  });

  it("verifies when the policy has no recorded version", () => {
    const plan = planProvider(canary("codex"), manifest, "0.0.45", { "@openai/codex": "0.157.0" });
    expect(plan.kind).toBe("verify");
  });

  it("blocks a release outside the supported ranges, even when forced", () => {
    const plan = planProvider(
      canary("codex"),
      manifest,
      "0.0.45",
      { "@openai/codex": "0.150.0" },
      true,
    );
    expect(plan).toMatchObject({ kind: "blocked", provider: "codex" });
    expect(plan.kind === "blocked" && plan.reason).toContain("@openai/codex@0.150.0 is broken");
  });

  it("blocks a provider without an applicable policy", () => {
    const plan = planProvider(canary("claudeAgent"), manifest, "0.0.45", {
      "@anthropic-ai/claude-code": "2.1.300",
    });
    expect(plan.kind).toBe("blocked");
  });

  it("picks the OpenCode package whose release is supported", () => {
    const plan = planProvider(canary("opencode"), manifest, "0.0.45", {
      "opencode-ai": "1.15.0",
      "@opencode/cli": "2.0.21",
    });
    expect(plan).toMatchObject({
      kind: "verify",
      entry: { packageName: "@opencode/cli", version: "2.0.21" },
    });
  });

  it("ignores prerelease tags", () => {
    const plan = planProvider(canary("codex"), manifest, "0.0.45", {
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
  it("inserts the version before ranges and bumps updatedAt without reformatting", () => {
    const next = recordVersions(
      MANIFEST_TEXT,
      "0.0.45",
      [{ provider: "codex", version: "0.158.0" }],
      NOW,
    );
    expect(next).toBe(
      MANIFEST_TEXT.replace("2026-10-11T20:00:00.000Z", NOW.toISOString()).replace(
        `"recommendedRange": ">=0.159.0",\n`,
        `"recommendedRange": ">=0.159.0",\n      "autoUpdateVersion": "0.158.0",\n`,
      ),
    );
  });

  it("replaces an existing version on the applicable policy only", () => {
    const next = recordVersions(
      MANIFEST_TEXT,
      "0.0.43",
      [{ provider: "codex", version: "0.160.0" }],
      NOW,
    );
    const parsed = JSON.parse(next);
    expect(parsed.compatibility[1].autoUpdateVersion).toBe("0.160.0");
    expect(parsed.compatibility[0].autoUpdateVersion).toBeUndefined();
    expect(parsed.compatibility[2].autoUpdateVersion).toBe("2.0.20");
  });

  it("records several providers at once", () => {
    const parsed = JSON.parse(
      recordVersions(
        MANIFEST_TEXT,
        "0.0.45",
        [
          { provider: "opencode", version: "2.0.21" },
          { provider: "codex", version: "0.158.0" },
        ],
        NOW,
      ),
    );
    expect(parsed.compatibility[0].autoUpdateVersion).toBe("0.158.0");
    expect(parsed.compatibility[2].autoUpdateVersion).toBe("2.0.21");
  });

  it("refuses versions outside a supported range", () => {
    expect(() =>
      recordVersions(MANIFEST_TEXT, "0.0.45", [{ provider: "opencode", version: "1.15.0" }], NOW),
    ).toThrow("graceful");
  });

  it("refuses versions older than the recorded one", () => {
    expect(() =>
      recordVersions(MANIFEST_TEXT, "0.0.45", [{ provider: "opencode", version: "2.0.19" }], NOW),
    ).toThrow("older than the recorded 2.0.20");
  });

  it("refuses an updatedAt that does not move forward", () => {
    expect(() =>
      recordVersions(
        MANIFEST_TEXT,
        "0.0.45",
        [{ provider: "codex", version: "0.158.0" }],
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
      "0.0.45",
      [{ provider: "claudeAgent", version }],
      new Date(Date.parse(bundled.updatedAt) + 1000),
    );
    expect(next.endsWith("}\n")).toBe(true);
    expect(next.split("\n").length).toBe(text.split("\n").length + 1);
  });
});
