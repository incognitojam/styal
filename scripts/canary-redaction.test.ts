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

type WorkflowStep = {
  id?: string;
  name: string;
  run?: string;
  if?: string;
  with?: { path?: string };
};
const workflowSteps = () =>
  (
    parse(
      NodeFS.readFileSync(
        new URL("../.github/workflows/provider-canary.yml", import.meta.url),
        "utf8",
      ),
    ) as { jobs: { verify: { steps: WorkflowStep[] } } }
  ).jobs.verify.steps;

/** A runner workspace with main's sanitizer and a stub verifier that copies `fixture` as its evidence. */
function canaryWorkspace(root: string, fixture: Record<string, string>) {
  const tools = NodePath.join(root, ".canary-tools/scripts");
  NodeFS.mkdirSync(tools, { recursive: true });
  NodeFS.copyFileSync(
    new URL("./canary-redaction.ts", import.meta.url),
    NodePath.join(tools, "canary-redaction.ts"),
  );
  NodeFS.mkdirSync(NodePath.join(root, "canary-outcome"));
  const evidence = NodePath.join(root, "fixture");
  NodeFS.mkdirSync(evidence);
  for (const [name, content] of Object.entries(fixture))
    NodeFS.writeFileSync(NodePath.join(evidence, name), content);
  return (script: string, env: Record<string, string> = {}) =>
    NodeChildProcess.spawnSync(
      "bash",
      [
        "-e",
        "-c",
        `node() {
    if [[ "$1" == apps/server/scripts/verify-provider-live.ts ]]; then
      printf 'attempt\n' >> "$ATTEMPTS"
      local evidence
      evidence="$(mktemp -d "$RUNNER_TEMP/styal-provider-live-XXXXXX")"
      cp "$EVIDENCE_FIXTURE"/* "$evidence"
      printf 'Evidence: %s\n' "$evidence"
      [[ -z "$VERIFIER_STDOUT" ]] || printf '%s\n' "$VERIFIER_STDOUT"
      [[ -z "$VERIFIER_STDERR" ]] || printf '%s\n' "$VERIFIER_STDERR" >&2
      [[ -z "$VERIFIER_PADDING" ]] || head -c "$VERIFIER_PADDING" /dev/zero | tr '\\0' x
      if [[ -n "$VERIFIER_STOP" ]]; then
        kill -INT $$
        exec tail -f /dev/null
      fi
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
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: root,
          REAL_NODE: process.execPath,
          EVIDENCE_FIXTURE: evidence,
          ATTEMPTS: NodePath.join(root, "attempts"),
          GITHUB_OUTPUT: NodePath.join(root, "output"),
          GITHUB_STEP_SUMMARY: NodePath.join(root, "summary"),
          PROVIDER: "opencode",
          STYAL: "1.0.0",
          VERSION: "1.0.0",
          PACKAGE: "@opencode/cli",
          MODEL: "synthetic",
          API_KEY: "synthetic-key-123456",
          SECRET_NAME: "API_KEY",
          ...env,
        },
      },
    );
}

it("redacts the job log and every uploaded evidence file of a failed verification", () => {
  using folder = scratch();
  const key = `sk-synthetic-${secret}`;
  const forms = [key, ...encodings(key)];
  const patterned = "sk-syntheticPatternKey1234567890";
  const wrapped = [key, Buffer.from(key).toString("base64")].map((form) => form.match(/.{1,16}/g)!);
  const runStep = canaryWorkspace(folder.root, {
    "result.json": JSON.stringify({
      provider: "opencode",
      version: "1.0.0",
      model: "synthetic",
      scenarios: [{ name: "turn", status: "failed", seconds: 3, detail: `rejected ${key}` }],
    }),
    "projection-thread-1.json": JSON.stringify({ threadId: "thread-1", error: forms.join(" ") }),
    "events-thread-1.ndjson": forms
      .map((form) => JSON.stringify({ type: "thread.activity", payload: { text: `key ${form}` } }))
      .concat(JSON.stringify({ type: "thread.turn-completed", payload: { apiKey: patterned } }))
      .join("\n"),
    "server.log": [
      "INFO server listening",
      ...forms.map((form) => `WARN provider request failed key=${form}`),
      ...wrapped.map((lines) => `WARN provider response:\n${lines.join("\n")}`),
      `ERROR ${JSON.stringify({ headers: { authorization: `Bearer ${patterned}` } })}`,
    ].join("\n"),
  });
  const env = {
    API_KEY: key,
    VERIFIER_STDOUT: `turn: provider rejected ${forms.join(" ")}\n${wrapped[1]!.join("\n")}`,
    VERIFIER_STDERR: `Error: request failed with ${patterned}\n${wrapped[0]!.join("\n")}`,
  };
  const steps = workflowSteps();
  const verify = runStep(steps.find((step) => step.id === "verify")!.run!, env);
  expect(verify.status).toBe(1);
  expect(NodeFS.readFileSync(NodePath.join(folder.root, "output"), "utf8")).toContain(
    "publish_evidence=true",
  );
  const upload = steps.find((step) => step.name === "Upload evidence")!;
  expect(upload.if).toContain("steps.redact_evidence.outcome == 'success'");
  const redact = runStep(steps.find((step) => step.id === "redact_evidence")!.run!, env);
  expect(redact.status, redact.stderr).toBe(0);

  const jobLog = verify.stdout + verify.stderr + redact.stdout + redact.stderr;
  expect(jobLog).toContain("turn: provider rejected [redacted]");
  expect(jobLog).toContain("Error: request failed with [redacted]");
  const uploaded = upload
    .with!.path!.trim()
    .split("\n")
    .flatMap((pattern) =>
      NodeFS.globSync(pattern.trim().replace("${{ runner.temp }}", folder.root)),
    );
  expect(uploaded.map((file) => NodePath.basename(file)).toSorted()).toEqual(
    ["events-thread-1.ndjson", "projection-thread-1.json", "result.json", "server.log"]
      .flatMap((name) => [name, name])
      .toSorted(),
  );
  const published = [
    jobLog,
    NodeFS.readFileSync(NodePath.join(folder.root, "summary"), "utf8"),
    NodeFS.readFileSync(NodePath.join(folder.root, "canary-outcome/opencode-1.0.0.json"), "utf8"),
    ...uploaded.map((file) => NodeFS.readFileSync(file, "utf8")),
  ];
  for (const output of published) {
    for (const form of forms) expect(output.replace(/\s+/g, "")).not.toContain(form);
    for (const fragment of wrapped.flat()) expect(output).not.toContain(fragment);
    expect(output).not.toContain(patterned);
  }
  const [log, events] = ["server.log", "events-thread-1.ndjson"].map((name) =>
    NodeFS.readFileSync(
      uploaded.find((file) => file.endsWith(name))!,
      "utf8",
    ),
  );
  expect(log).toContain("WARN provider request failed key=[redacted]");
  expect(log).toContain("Bearer [redacted]");
  expect(
    events!
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type),
  ).toEqual([...forms.map(() => "thread.activity"), "thread.turn-completed"]);
});

const withheldKey = `sk-synthetic-${secret}`;
const encodedKey = Buffer.from(withheldKey).toString("base64");
const wrappedKey = encodedKey.match(/.{1,16}/g)!.join("\n");
it.each([
  {
    name: "result sanitization fails",
    fixture: { "result.json": JSON.stringify({ detail: encodedKey }).slice(0, -1) },
    env: {},
    line: "Canary data sanitization failed; result withheld.",
    detail: "Verification result could not be published safely because sanitization failed.",
  },
  {
    name: "the step is stopped mid-key",
    fixture: { "result.json": "{}" },
    env: { VERIFIER_STDOUT: `turn: rejected\n${wrappedKey.slice(0, -1)}`, VERIFIER_STOP: "1" },
    line: "Verifier output withheld: the step was stopped.",
    detail: "Verification was stopped before it finished, so its output was withheld.",
  },
  {
    name: "the output is too large",
    fixture: { "result.json": "{}" },
    env: { VERIFIER_STDOUT: wrappedKey, VERIFIER_PADDING: String(17 * 1024 * 1024) },
    line: "Verifier output withheld: it is larger than 16 MiB.",
    detail: "Verifier output was withheld because it could not be sanitized or was too large.",
  },
])("publishes only a fixed safe problem and no evidence when $name", (row) => {
  using folder = scratch();
  const runStep = canaryWorkspace(folder.root, row.fixture);
  const steps = workflowSteps();
  const child = runStep(steps.find((step) => step.id === "verify")!.run!, {
    API_KEY: withheldKey,
    ...row.env,
  });
  expect(child.status).toBe(1);
  const jobLog = child.stdout + child.stderr;
  expect(jobLog).toContain(row.line);
  const joined = jobLog.replace(/\s+/g, "");
  for (let start = 0; start + 8 <= encodedKey.length; start++)
    expect(joined).not.toContain(encodedKey.slice(start, start + 8));
  expect(NodeFS.readFileSync(NodePath.join(folder.root, "attempts"), "utf8")).toBe("attempt\n");
  expect(NodeFS.readFileSync(NodePath.join(folder.root, "output"), "utf8")).toContain(
    "publish_evidence=false",
  );
  const outcome = JSON.parse(
    NodeFS.readFileSync(NodePath.join(folder.root, "canary-outcome/opencode-1.0.0.json"), "utf8"),
  );
  expect(outcome).toMatchObject({ outcome: "failed", detail: row.detail });
  expect(steps.find((step) => step.name === "Upload evidence")!.if).toContain(
    "steps.verify.outputs.publish_evidence == 'true'",
  );
  expect(steps.find((step) => step.name === "Upload evidence")!.if).toContain(
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
