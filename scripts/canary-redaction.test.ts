// @effect-diagnostics nodeBuiltinImport:off -- Exercises the sanitizer CLI and verifier publication gate with synthetic files.
import { expect, it } from "vite-plus/test";
import { redactCanary } from "./canary-redaction.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { parse } from "yaml";
import { collectRun, reconcileStatusIssue } from "./provider-canary.ts";

it("redacts every outcome string, including split and JSON-escaped secrets", () => {
  const secret = "synthetic-canary-secret-123456";
  const outcome = {
    provider: secret,
    detail: `rewind: ${secret} again ${secret}`,
    nested: [
      secret.slice(0, 12) + "\n" + secret.slice(12),
      JSON.stringify({ error: secret }),
      secret.slice(0, 12) + "\\n" + secret.slice(12),
      "\\u0073" + secret.slice(1),
    ],
  };
  const clean = redactCanary(outcome, [secret]);
  expect(clean).toEqual({
    provider: "[redacted]",
    detail: "rewind: [redacted] again [redacted]",
    nested: ["[redacted]", '{"error":"[redacted]"}', "[redacted]", "[redacted]"],
  });
});
it.each([
  "sk-syntheticKey1234567890",
  "ghp_syntheticToken1234567890",
  "Bearer synthetic-token-123",
  'api_key="' + "a".repeat(64) + '"',
  "token: " + "Ab9/".repeat(20),
])("redacts common token patterns without secret values: %s", (token) => {
  expect(JSON.stringify(redactCanary({ detail: `failed ${token}` }))).not.toContain(token);
  expect(redactCanary({ detail: `failed ${token}` })).toEqual({
    detail: expect.stringContaining("[redacted]"),
  });
});
it("redacts long tokens in JSON fields and JSON-escaped error text", () => {
  const token = "abCD1234".repeat(8);
  expect(
    redactCanary({ api_key: token, detail: JSON.stringify({ token }).replaceAll('"', '\\"') }),
  ).toEqual({ api_key: "[redacted]", detail: '{\\"token\\":\\"[redacted]\\"}' });
});
it("ignores short exact secrets while preserving pattern redaction and warning by variable name", () => {
  const warnings: string[] = [];
  expect(
    redactCanary({ detail: "concatenate sk-syntheticKey1234567890" }, ["cat"], (message) =>
      warnings.push(message),
    ),
  ).toEqual({ detail: "concatenate [redacted]" });
  expect(warnings).toEqual(["Ignoring API_KEY shorter than 8 characters for exact redaction."]);
});

function scratch() {
  const root = NodeFS.mkdtempSync(
    NodePath.resolve(import.meta.dirname, "../.scratch/canary-confirm-"),
  );
  return {
    root,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const secret = "SyntheticKey+A/B=123456789";
const encodings = (value: string) => [
  encodeURIComponent(value),
  encodeURIComponent(value).replaceAll("%2B", "+"),
  new URLSearchParams({ key: value }).toString().slice(4),
  Buffer.from(value).toString("base64"),
  Buffer.from(value).toString("base64").replace(/=+$/, ""),
  Buffer.from(value).toString("base64url"),
  Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_"),
  JSON.stringify(value).slice(1, -1),
];
it.each([secret, secret + "A", secret + " with space"])(
  "redacts whole-value encodings through CLI to body, comment and title: %s",
  (value) => {
    using folder = scratch();
    const forms = encodings(value);
    const file = NodePath.join(folder.root, "outcome.json");
    NodeFS.writeFileSync(
      file,
      JSON.stringify({
        provider: "codex",
        packageName: "@openai/codex",
        version: forms.join(" "),
        styal: "1.0.0",
        outcome: "failed",
        detail: forms.join(" "),
      }),
    );
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.resolve(import.meta.dirname, "canary-redaction.ts"), file],
      { encoding: "utf8", env: { ...process.env, API_KEY: value } },
    );
    expect(child.status, child.stderr).toBe(0);
    const clean = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    const run = collectRun({
      plan: {
        plans: [
          {
            kind: "verify",
            provider: "codex",
            styal: clean.styal,
            entry: { ...clean, binary: "codex", model: "synthetic", secret: "API_KEY" },
          },
        ],
      },
      outcomes: [clean],
      planResult: "success",
      recordResult: "skipped",
    });
    const first = reconcileStatusIssue(null, run, [], "https://example.test/run")!;
    const changed = reconcileStatusIssue(
      {
        number: 7,
        open: true,
        body: reconcileStatusIssue(
          null,
          {
            problems: [{ key: "job:plan", scope: "job:plan", summary: "failed" }],
            evaluated: new Set(),
          },
          [],
          "https://example.test/previous",
        )!.body,
      },
      run,
      [],
      "https://example.test/run",
    )!;
    const state = Buffer.from(
      /provider-canary-state ([a-f0-9]+)/.exec(first.body)![1]!,
      "hex",
    ).toString("utf8");
    for (const form of forms) {
      for (const output of [
        NodeFS.readFileSync(file, "utf8"),
        first.body,
        first.title!,
        changed.comment!,
        state,
      ])
        expect(output).not.toContain(form);
    }
    expect(first.body).toContain("[redacted]");
    expect(changed.comment).toContain("[redacted]");
    expect(first.title).toContain("[redacted]");
  },
);

it("publishes only a fixed safe problem and no evidence when result sanitization fails", () => {
  using folder = scratch();
  const tools = NodePath.join(folder.root, ".canary-tools/scripts");
  NodeFS.mkdirSync(tools, { recursive: true });
  NodeFS.copyFileSync(
    new URL("./canary-redaction.ts", import.meta.url),
    NodePath.join(tools, "canary-redaction.ts"),
  );
  NodeFS.mkdirSync(NodePath.join(folder.root, "canary-outcome"));
  const evidence = NodePath.join(folder.root, "styal-provider-live-synthetic");
  NodeFS.mkdirSync(evidence);
  const encodedSecret = Buffer.from("synthetic-key-123456").toString("base64");
  NodeFS.writeFileSync(
    NodePath.join(evidence, "result.json"),
    JSON.stringify({ detail: encodedSecret }).slice(0, -1),
  );
  const workflow = parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/provider-canary.yml", import.meta.url),
      "utf8",
    ),
  ) as { jobs: { verify: { steps: { id?: string; name: string; run?: string; if?: string }[] } } };
  const script = workflow.jobs.verify.steps.find((step) => step.id === "verify")!.run!;
  const child = NodeChildProcess.spawnSync(
    "bash",
    [
      "-c",
      `node() {
    if [[ "$1" == apps/server/scripts/verify-provider-live.ts ]]; then
      printf 'attempt\n' >> "$ATTEMPTS"
      printf 'Evidence: %s\n' "$EVIDENCE_FIXTURE"
      return 1
    fi
    "$REAL_NODE" "$@"
  }
` + script,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: folder.root,
        RUNNER_TEMP: folder.root,
        REAL_NODE: process.execPath,
        EVIDENCE_FIXTURE: evidence,
        ATTEMPTS: NodePath.join(folder.root, "attempts"),
        GITHUB_OUTPUT: NodePath.join(folder.root, "output"),
        GITHUB_STEP_SUMMARY: NodePath.join(folder.root, "summary"),
        PROVIDER: "opencode",
        STYAL: "1.0.0",
        VERSION: "1.0.0",
        PACKAGE: "@opencode/cli",
        MODEL: "synthetic",
        API_KEY: "synthetic-key-123456",
        SECRET_NAME: "API_KEY",
      },
    },
  );
  expect(child.status).toBe(1);
  expect(child.stdout + child.stderr).not.toContain(encodedSecret);
  expect(NodeFS.readFileSync(NodePath.join(folder.root, "attempts"), "utf8")).toBe("attempt\n");
  expect(NodeFS.readFileSync(NodePath.join(folder.root, "output"), "utf8")).toContain(
    "publish_evidence=false",
  );
  const outcome = JSON.parse(
    NodeFS.readFileSync(NodePath.join(folder.root, "canary-outcome/opencode-1.0.0.json"), "utf8"),
  );
  expect(outcome).toMatchObject({
    outcome: "failed",
    detail: "Verification result could not be published safely because sanitization failed.",
  });
  expect(workflow.jobs.verify.steps.find((step) => step.name === "Upload evidence")!.if).toContain(
    "steps.verify.outputs.publish_evidence == 'true'",
  );
  expect(workflow.jobs.verify.steps.find((step) => step.name === "Upload evidence")!.if).toContain(
    "steps.redact.outcome == 'success'",
  );
  const run = collectRun({
    plan: {
      plans: [
        {
          kind: "verify",
          provider: "opencode",
          styal: "1.0.0",
          entry: { ...outcome, binary: "opencode", model: "synthetic", secret: "API_KEY" },
        },
      ],
    },
    outcomes: [outcome],
    planResult: "success",
    recordResult: "skipped",
  });
  expect(reconcileStatusIssue(null, run, [], "https://example.test/run")!.body).toContain(
    outcome.detail,
  );
});
