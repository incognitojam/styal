// @effect-diagnostics nodeBuiltinImport:off -- Exercises the sanitizer CLI and verifier publication gate with synthetic files.
import { expect, it } from "vite-plus/test";
import { redactCanary } from "./canary-redaction.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { parse } from "yaml";
import { collectRun, reconcileStatusIssue } from "./provider-canary.ts";

const unicodeEscaped = (value: string) =>
  Array.from(value, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

it("redacts every outcome string, including split and JSON-escaped secrets", () => {
  const secret = "synthetic-canary-secret-123456";
  const nested = JSON.stringify({ response: unicodeEscaped(secret) });
  const outcome = {
    provider: secret,
    detail: `rewind: ${secret} again ${secret}`,
    nested: [
      secret.slice(0, 12) + "\n" + secret.slice(12),
      JSON.stringify({ error: secret }),
      secret.slice(0, 12) + "\\n" + secret.slice(12),
      "\\u0073" + secret.slice(1),
      ("WARN " + "x".repeat(275) + secret).slice(0, 300),
      ("WARN " + "x".repeat(270) + Buffer.from(secret).toString("base64")).slice(0, 300),
      Buffer.from(`user:${secret}`).toString("base64"),
      JSON.stringify({ text: secret.slice(0, 16) }),
      Buffer.from(secret).toString("base64").slice(0, 11),
      nested,
      // Each escaped character is 7 characters long; cut after the 8th.
      nested.slice(0, '{"response":"'.length + 7 * 8),
    ],
  };
  const clean = redactCanary(outcome, [secret]);
  expect(clean).toEqual({
    provider: "[redacted]",
    detail: "rewind: [redacted] again [redacted]",
    nested: [
      "[redacted]",
      '{"error":"[redacted]"}',
      "[redacted]",
      "[redacted]",
      "WARN " + "x".repeat(275) + "[redacted]",
      "WARN " + "x".repeat(270) + "[redacted]",
      Buffer.from(`user:${secret}`).toString("base64").slice(0, 8) + "[redacted]",
      '{"text":"[redacted]"}',
      // Fragments shorter than 12 characters are the accepted limit.
      Buffer.from(secret).toString("base64").slice(0, 11),
      '{"response":"[redacted]"}',
      '{"response":"[redacted]',
    ],
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
      printf '%s\n' "$BASHPID" > "$RUNNER_TEMP/verifier.pid"
      [[ -z "$VERIFIER_IGNORE_TERM" ]] || trap '' TERM
      local evidence
      evidence="$(mktemp -d "$RUNNER_TEMP/styal-provider-live-XXXXXX")"
      cp "$EVIDENCE_FIXTURE"/* "$evidence"
      printf 'Evidence: %s\n' "$evidence"
      [[ -z "$VERIFIER_STDOUT" ]] || printf '%s\n' "$VERIFIER_STDOUT"
      [[ -z "$VERIFIER_STDERR" ]] || printf '%s\n' "$VERIFIER_STDERR" >&2
      if [[ -n "$VERIFIER_STOP" ]]; then
        kill -INT $$
        exec tail -f /dev/null
      fi
      [[ -z "$VERIFIER_KILLED" ]] || kill -KILL $BASHPID
      return "\${VERIFIER_EXIT:-1}"
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

const withheldKey = `sk-synthetic-${secret}`;
const encodedKey = Buffer.from(withheldKey).toString("base64");
const wrappedKey = encodedKey.match(/.{1,16}/g)!.join("\n");
const leakedKeyFragments = (output: string) => {
  const joined = output
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\s+/g, "");
  const windows: Array<[string, number]> = [
    [encodedKey, 8],
    [withheldKey, 12],
  ];
  return windows.flatMap(([form, size]) =>
    Array.from({ length: form.length - size + 1 }, (_, start) =>
      form.slice(start, start + size),
    ).filter((fragment) => joined.includes(fragment)),
  );
};
const verifierProcessGone = (root: string) => {
  try {
    process.kill(Number(NodeFS.readFileSync(NodePath.join(root, "verifier.pid"), "utf8")), 0);
    return false;
  } catch {
    return true;
  }
};

it.each([
  {
    name: "exits with a failure",
    env: {},
    serverLogTail: wrappedKey.slice(0, 30),
    logs: ["server.log", "verifier-output.log"],
  },
  {
    name: "is killed by a signal mid-key",
    env: { VERIFIER_KILLED: "1", VERIFIER_STDOUT: `stdout: rejected\n${wrappedKey.slice(0, -1)}` },
    serverLogTail: wrappedKey.slice(0, -1),
    logs: [],
  },
])(
  "keeps verifier output off the job log and redacts uploaded evidence when the verifier $name",
  (row) => {
    using folder = scratch();
    const key = withheldKey;
    const forms = [key, ...encodings(key)];
    const patterned = "sk-syntheticPatternKey1234567890";
    const wrapped = [key, Buffer.from(key).toString("base64")].map((form) =>
      form.match(/.{1,16}/g)!,
    );
    const runStep = canaryWorkspace(folder.root, {
      "result.json": JSON.stringify({
        provider: "opencode",
        version: "1.0.0",
        model: "synthetic",
        scenarios: [
          { name: "turn", status: "failed", seconds: 3, detail: `rejected ${key}` },
          ...[encodedKey, key].map((form, offset) => ({
            name: "clean-projection",
            status: "failed",
            seconds: 1,
            detail: `server log: WARN ${"x".repeat(260 + offset * 5)}${form}`.slice(0, 300),
          })),
          ...[Infinity, 13 + 7 * 14].map((length) => ({
            name: "turn",
            status: "failed",
            seconds: 2,
            detail: JSON.stringify({ response: unicodeEscaped(key) }).slice(0, length),
          })),
        ],
      }),
      "projection-thread-1.json": JSON.stringify({ threadId: "thread-1", error: forms.join(" ") }),
      "events-thread-1.ndjson": forms
        .map((form) =>
          JSON.stringify({ type: "thread.activity", payload: { text: `key ${form}` } }),
        )
        .concat(
          [key.slice(0, 20), encodedKey.slice(0, 20)].map((prefix) =>
            JSON.stringify({ type: "thread.activity", payload: { text: prefix } }),
          ),
        )
        .concat(JSON.stringify({ type: "thread.turn-completed", payload: { apiKey: patterned } }))
        .join("\n"),
      "server.log": [
        "INFO server listening",
        ...forms.map((form) => `WARN provider request failed key=${form}`),
        ...wrapped.map((lines) => `WARN provider response:\n${lines.join("\n")}`),
        `ERROR ${JSON.stringify({ headers: { authorization: `Bearer ${patterned}` } })}`,
        `WARN provider response:\n${row.serverLogTail}`,
      ].join("\n"),
    });
    const env = {
      API_KEY: key,
      VERIFIER_STDOUT: `turn: provider rejected ${forms.join(" ")}\n${wrapped[1]!.join("\n")}\n${wrappedKey.slice(0, 30)}`,
      VERIFIER_STDERR: `Error: request failed with ${patterned}\n${wrapped[0]!.join("\n")}`,
      ...row.env,
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
    expect(jobLog).toContain("Attempt 2: the verifier exited with status");
    for (const printed of ["provider rejected", "stdout: rejected", "request failed with"])
      expect(jobLog).not.toContain(printed);
    const uploaded = upload
      .with!.path!.trim()
      .split("\n")
      .flatMap((pattern) =>
        NodeFS.globSync(pattern.trim().replace("${{ runner.temp }}", folder.root)),
      );
    expect(uploaded.map((file) => NodePath.basename(file)).toSorted()).toEqual(
      ["events-thread-1.ndjson", "projection-thread-1.json", "result.json", ...row.logs]
        .flatMap((name) => [name, name])
        .toSorted(),
    );
    expect(
      NodeFS.readdirSync(folder.root).filter((name) => name.startsWith("verifier-output")),
    ).toEqual([]);
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
      expect(leakedKeyFragments(output)).toEqual([]);
    }
    const read = (name: string) =>
      NodeFS.readFileSync(
        uploaded.find((file) => file.endsWith(name))!,
        "utf8",
      );
    if (row.logs.length > 0) {
      expect(read("server.log")).toContain("WARN provider request failed key=[redacted]");
      expect(read("server.log")).toContain("Bearer [redacted]");
      expect(read("verifier-output.log")).toContain("turn: provider rejected [redacted]");
      expect(read("verifier-output.log")).toContain("Error: request failed with [redacted]");
    }
    const events = read("events-thread-1.ndjson");
    expect(
      events!
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).type),
    ).toEqual([
      ...forms.map(() => "thread.activity"),
      "thread.activity",
      "thread.activity",
      "thread.turn-completed",
    ]);
  },
);

it.each([
  {
    name: "result sanitization fails with a key prefix in the output",
    fixture: { "result.json": JSON.stringify({ detail: encodedKey }).slice(0, -1) },
    env: { VERIFIER_STDOUT: `stdout: rejected\n${wrappedKey.slice(0, -1)}` },
    line: "Canary data sanitization failed; result withheld.",
    detail:
      "Verification result could not be published safely because it failed sanitization or validation.",
  },
  {
    name: "result.json has the wrong shape and the verifier exits 0",
    fixture: { "result.json": JSON.stringify({ scenarios: "passed" }) },
    env: { VERIFIER_STDOUT: `stdout: rejected\n${wrappedKey.slice(0, -1)}`, VERIFIER_EXIT: "0" },
    line: "failed verification::Verification result could not be published safely because it failed sanitization or validation.",
    detail:
      "Verification result could not be published safely because it failed sanitization or validation.",
  },
  {
    name: "the step is stopped mid-key",
    fixture: { "result.json": "{}" },
    env: { VERIFIER_STDOUT: `stdout: rejected\n${wrappedKey.slice(0, -1)}`, VERIFIER_STOP: "1" },
    line: "failed verification::Verification was stopped before it finished.",
    detail: "Verification was stopped before it finished.",
  },
  {
    name: "the step is stopped and the verifier ignores SIGTERM",
    fixture: { "result.json": "{}" },
    env: {
      VERIFIER_STDOUT: `stdout: rejected\n${wrappedKey.slice(0, -1)}`,
      VERIFIER_STOP: "1",
      VERIFIER_IGNORE_TERM: "1",
    },
    line: "failed verification::Verification was stopped before it finished.",
    detail: "Verification was stopped before it finished.",
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
  expect(jobLog).not.toContain("stdout: rejected");
  expect(leakedKeyFragments(jobLog)).toEqual([]);
  expect(verifierProcessGone(folder.root)).toBe(true);
  expect(
    NodeFS.readdirSync(folder.root).filter((name) => name.startsWith("verifier-output")),
  ).toEqual([]);
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
