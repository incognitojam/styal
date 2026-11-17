// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Reads the report workflow and checks hold dates with explicit timestamps.
import { expect, it } from "vite-plus/test";
import {
  collectRun,
  reconcileStatusIssue,
  syncCanaryReport,
  statusFailures,
} from "./provider-canary.ts";
import * as NodeFS from "node:fs";
import { redactCanary } from "./canary-redaction.ts";

const runUrl = "https://example.test/runs/1";
const failed = {
  problems: [{ key: "failed:codex:1", scope: "codex", summary: "codex 1 failed" }],
  evaluated: new Set(["codex"]),
};
const passed = { ...failed, problems: [] };
function fixture(numbers: number[] = []) {
  const issues = new Map(
    numbers.map((number) => [
      number,
      { number, open: true, body: reconcileStatusIssue(null, failed, [], runUrl)!.body },
    ]),
  );
  const comments = new Map<number, { body: string }[]>();
  const calls: { method: string; path: string; body?: object }[] = [];
  const request = async <T>(method: string, path: string, body?: object): Promise<T> => {
    calls.push({ method, path, ...(body ? { body } : {}) });
    let result: unknown = {};
    const number = Number(path.split("/issues/")[1]?.split("/")[0]);
    if (path.includes("/issues?")) result = [...issues.values()];
    else if (path.includes("/comments")) {
      if (method === "GET") result = comments.get(number) ?? [];
      else comments.set(number, [...(comments.get(number) ?? []), body as { body: string }]);
    } else if (method === "POST" && path.endsWith("/issues")) {
      const issue = { number: 7, open: true, ...(body as { body: string }) };
      issues.set(7, issue);
      result = issue;
    } else if (method === "PATCH") {
      if ((body as { state?: string }).state === "closed") issues.delete(number);
      else Object.assign(issues.get(number)!, body);
    }
    return result as T;
  };
  return {
    issues,
    comments,
    calls,
    options: { request, repo: "example/project", run: failed, notes: [], runUrl, dryRun: false },
  };
}
it("serializes overlapping reports before listing, then opens once and comments only on changed problems", async () => {
  const state = fixture();
  // GitHub's report concurrency group queues these calls, including separate dispatches.
  const workflow = NodeFS.readFileSync(
    new URL("../.github/workflows/provider-canary.yml", import.meta.url),
    "utf8",
  );
  expect(workflow.slice(workflow.indexOf("  report:"))).toContain(
    "group: provider-canary-report\n      cancel-in-progress: false",
  );
  await syncCanaryReport(state.options);
  await syncCanaryReport(state.options);
  expect(state.calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues"))).toHaveLength(
    1,
  );
  expect(state.comments.size).toBe(0);
  await syncCanaryReport({
    ...state.options,
    run: {
      ...failed,
      problems: [
        ...failed.problems,
        { key: "blocked:other", scope: "other", summary: "unsupported" },
      ],
    },
  });
  expect(state.comments.get(7)).toHaveLength(1);
  await syncCanaryReport({ ...state.options, run: failed });
  expect(state.comments.get(7)).toHaveLength(1); // Unchecked other provider is preserved.
  await syncCanaryReport({
    ...state.options,
    run: { ...failed, evaluated: new Set(["codex", "other"]) },
  });
  expect(state.comments.get(7)).toHaveLength(2);
});
it("recovers two open issues once, including a retry after closing fails on a later run", async () => {
  const state = fixture([7, 8]);
  let fail = true;
  const request: typeof state.options.request = async (method, path, body) => {
    if (method === "PATCH" && (body as { state?: string }).state === "closed" && fail) {
      fail = false;
      throw new Error("close failed");
    }
    return state.options.request(method, path, body);
  };
  await expect(syncCanaryReport({ ...state.options, request, run: passed })).rejects.toThrow(
    "close failed",
  );
  await syncCanaryReport({
    ...state.options,
    request,
    run: passed,
    runUrl: "https://example.test/runs/2",
  });
  expect(state.comments.get(7)).toHaveLength(1);
  expect(state.comments.get(8)).toHaveLength(1);
  expect(state.issues.size).toBe(0);
  for (const number of [7, 8]) {
    const updated = state.calls.find(
      (c) =>
        c.method === "PATCH" &&
        c.path.endsWith(`/issues/${number}`) &&
        (c.body as { body?: string }).body,
    );
    expect(updated?.body).toMatchObject({
      body: expect.stringContaining("Every provider canary check passed."),
    });
    expect((updated!.body as { body: string }).body).toContain(
      `https://example.test/runs/${number === 7 ? 1 : 2}`,
    );
  }
});
it.each(["GET", "POST", "PATCH"])("propagates %s API errors", async (failedMethod) => {
  const state = fixture(failedMethod === "PATCH" ? [7] : []);
  const request: typeof state.options.request = async (method, path, body) => {
    if (method === failedMethod) throw new Error("API failed");
    return state.options.request(method, path, body);
  };
  await expect(syncCanaryReport({ ...state.options, request })).rejects.toThrow("API failed");
});
it("keeps dry runs read-only, ignores 861, and warns only when an opening announcement fails", async () => {
  const state = fixture([861]);
  const warn = [] as string[];
  await syncCanaryReport({ ...state.options, dryRun: true });
  expect(state.calls.every((c) => c.method === "GET")).toBe(true);
  const options = {
    ...state.options,
    warn: (message: string) => warn.push(message),
    announce: async () => {
      throw new Error("Discord");
    },
  };
  await syncCanaryReport(options);
  await syncCanaryReport(options);
  expect(warn).toEqual(["Discord issue announcement could not be delivered."]);
  expect(state.calls.some((c) => c.path.includes("/issues/861"))).toBe(false);
});
it("escapes hostile output and keeps state inert", () => {
  const hostile = "` @example-user Fixes #42 </code><!--\n" + "x".repeat(2000);
  const run = collectRun({
    plan: { plans: [{ kind: "blocked", provider: "codex", styal: "1", reason: hostile }] },
    outcomes: [],
    planResult: "success",
    recordResult: "skipped",
  });
  const update = reconcileStatusIssue(null, run, [], runUrl)!;
  expect(update.body).toContain("- **codex** on styal 1&#58;");
  expect(update.body).not.toContain("@example-user");
  expect(update.body).toContain("&lt;/code&gt;&lt;\\!--");
  expect(update.body).not.toContain("x".repeat(501));
  expect(update.body).toMatch(/<!-- provider-canary-state [a-f0-9]+ -->/);
});
it("keeps two open issues on persistent failure without opening a third", async () => {
  const state = fixture([7, 8]);
  await syncCanaryReport(state.options);
  expect(state.calls.filter((c) => c.method === "POST")).toEqual([]);
  expect(state.issues.size).toBe(2);
});
it("creates missing labels idempotently and propagates label API failures", async () => {
  const state = fixture();
  const reads = new Set<string>();
  const request: typeof state.options.request = async (method, path, body) => {
    if (path.includes("/labels/")) {
      if (!reads.has(path)) {
        reads.add(path);
        throw { status: 404 };
      }
    }
    if (method === "POST" && path.endsWith("/labels")) throw { status: 422 };
    return state.options.request(method, path, body);
  };
  await syncCanaryReport({ ...state.options, request });
  expect(state.issues.size).toBe(1);
  await expect(
    syncCanaryReport({
      ...fixture().options,
      request: async () => {
        throw { status: 403 };
      },
    }),
  ).rejects.toEqual({ status: 403 });
});
it("opens one replacement per manual close, then stays quiet until another close", async () => {
  const state = fixture();
  for (let closure = 0; closure < 3; closure++) {
    state.issues.clear();
    await syncCanaryReport(state.options);
    await syncCanaryReport(state.options);
  }
  expect(state.calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues"))).toHaveLength(
    3,
  );
  expect(state.comments.size).toBe(0);
  expect(statusFailures(null)).toEqual([]);
});
it.each(["planResult", "recordResult"] as const)(
  "does nothing on %s cancellation",
  async (result) => {
    const state = fixture([7]);
    const run = collectRun({
      plan: undefined,
      outcomes: [],
      planResult: "success",
      recordResult: "skipped",
      [result]: "cancelled",
    });
    expect(await syncCanaryReport({ ...state.options, run })).toBe("Cancelled; no issue changes.");
    expect(state.calls).toEqual([]);
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/provider-canary.yml", import.meta.url),
      "utf8",
    );
    expect(workflow.slice(workflow.indexOf("  report:"))).toContain("!cancelled()");
  },
);
it("updates the title to the remaining failing provider after partial recovery", async () => {
  const state = fixture();
  const failure = (provider: string) => ({
    provider,
    packageName: provider,
    version: "1.0.0",
    styal: "1.0.0",
    at: "2026-11-14T00:00:00.000Z",
    detail: "failed",
  });
  const problems = [
    ...failed.problems,
    { key: "failed:claudeAgent:1", scope: "claudeAgent", summary: "Claude failed" },
  ];
  await syncCanaryReport({
    ...state.options,
    run: { ...failed, problems, failures: [failure("codex"), failure("claudeAgent")] },
  });
  await syncCanaryReport({
    ...state.options,
    run: { ...failed, evaluated: new Set(["codex", "claudeAgent"]), failures: [failure("codex")] },
  });
  expect(state.issues.get(7)).toMatchObject({
    title: "Provider canary: `codex` `1.0.0` fails verification",
  });
  expect(state.comments.get(7)).toHaveLength(1);
});
it.each([false, true])(
  "assigns the context owner after opening, warning on assignment failure=%s",
  async (fail) => {
    const state = fixture();
    const warnings: string[] = [];
    const request: typeof state.options.request = async (method, path, body) => {
      if (path.endsWith("/assignees")) {
        expect(body).toEqual({ assignees: ["example-owner"] });
        if (fail) throw new Error("assignment failed");
      }
      return state.options.request(method, path, body);
    };
    await syncCanaryReport({
      ...state.options,
      request,
      owner: "example-owner",
      warn: (message) => warnings.push(message),
    });
    expect(state.issues.size).toBe(1);
    expect(warnings).toHaveLength(fail ? 1 : 0);
  },
);
it("redacts known verifier secrets before reporting and patterns again in visible and stored text", () => {
  const secret = "synthetic-canary-secret-123456";
  const plan = {
    plans: [
      {
        kind: "verify" as const,
        provider: "codex",
        styal: "1.0.0",
        entry: {
          provider: "codex",
          packageName: "@openai/codex",
          version: "1.0.0",
          styal: "1.0.0",
          binary: "codex",
          model: "synthetic",
          secret: "API_KEY",
        },
      },
    ],
  };
  const outcome = redactCanary(
    {
      provider: "codex",
      packageName: "@openai/codex",
      version: "1.0.0",
      styal: "1.0.0",
      outcome: "failed" as const,
      detail: `rewind: ${secret} and sk-syntheticDefensiveKey12345678`,
    },
    [secret],
  );
  // The reporter also handles old artifacts containing recognizable token shapes.
  const run = collectRun({
    plan,
    outcomes: [{ ...outcome, detail: outcome.detail + " Bearer synthetic-token" }],
    planResult: "success",
    recordResult: "skipped",
  });
  const update = reconcileStatusIssue(null, run, [], runUrl)!;
  const state = Buffer.from(
    /provider-canary-state ([a-f0-9]+)/.exec(update.body)![1]!,
    "hex",
  ).toString("utf8");
  for (const value of [secret, "sk-syntheticDefensiveKey12345678", "synthetic-token"]) {
    expect(update.body).not.toContain(value);
    expect(state).not.toContain(value);
  }
  expect(JSON.parse(state).failures[0]).not.toHaveProperty("detail");
  expect(Object.keys(JSON.parse(state).failures[0]).sort()).toEqual([
    "at",
    "packageName",
    "provider",
    "styal",
    "version",
  ]);
});
it("bounds the real serialized issue body with 40,000-character hostile details", () => {
  const long = "🧨".repeat(40_000);
  const run = {
    ...failed,
    problems: Array.from({ length: 8 }, (_, i) => ({
      key: `failed:${i}`,
      scope: String(i),
      summary: long,
    })),
    failures: Array.from({ length: 8 }, (_, i) => ({
      provider: String(i),
      packageName: long,
      version: long,
      styal: long,
      at: long,
      detail: long,
    })),
  };
  const update = reconcileStatusIssue(null, run, Array(10).fill(long), runUrl)!;
  expect(update.body.length).toBeLessThan(30_000);
  expect(Buffer.byteLength(update.body)).toBeLessThan(30_000);
  const stored = JSON.parse(
    Buffer.from(/provider-canary-state ([a-f0-9]+)/.exec(update.body)![1]!, "hex").toString("utf8"),
  );
  expect(stored.failures[0]).not.toHaveProperty("detail");
  expect(stored.problems[0].summary.length).toBeLessThanOrEqual(200);
});
it.each(["{", '{"failures":{}}'])("ignores malformed hidden state: %s", (text) => {
  const warnings: string[] = [];
  const issue = {
    number: 7,
    open: true,
    body: `<!-- provider-canary-state ${Buffer.from(text).toString("hex")} -->`,
  };
  expect(
    statusFailures(issue, new Date("2026-11-14T12:00:00Z"), (message) => warnings.push(message)),
  ).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(reconcileStatusIssue(issue, passed, [], runUrl)?.state).toBe("closed");
});
it.each(["9999-01-01", "2026-11-14T05:59:59Z", "invalid-date", "2026-11-14T12:00:01Z"])(
  "rejects invalid, future or expired hold dates: %s",
  (at) => {
    const issue = {
      number: 7,
      open: true,
      body: `<!-- provider-canary-state ${Buffer.from(JSON.stringify({ failures: [{ provider: "codex", packageName: "@openai/codex", version: "1.0.0", styal: "1.0.0", at }] })).toString("hex")} -->`,
    };
    const warnings: string[] = [];
    expect(
      statusFailures(issue, new Date("2026-11-14T12:00:00Z"), (message) => warnings.push(message)),
    ).toEqual([]);
    expect(warnings.length).toBe(at === "2026-11-14T05:59:59Z" ? 0 : 1);
  },
);

it("renders separate failed-build bullets without activating untrusted Markdown", () => {
  const plans = ["0.1.1", "0.1.2"].map((styal) => ({
    kind: "verify" as const,
    provider: "codex",
    styal,
    entry: {
      provider: "codex",
      packageName: "@openai/codex",
      version: "0.169.1",
      styal,
      binary: "codex",
      model: "m",
      secret: "S",
    },
  }));
  const run = collectRun({
    plan: { plans },
    outcomes: plans.map(({ entry }) => ({
      ...entry,
      outcome: "failed" as const,
      detail: "[click](https://example.test) <img src=x> @everyone `code`\n- injected",
    })),
    planResult: "success",
    recordResult: "skipped",
  });
  expect(run.problems).toHaveLength(2);
  const opened = reconcileStatusIssue(null, run, [], runUrl)!;
  const bullets = opened.body.split("\n").filter((line) => line.startsWith("- "));
  expect(bullets).toHaveLength(2);
  expect(bullets[0]).toContain("**&#64;openai/codex&#64;0.169.1** on styal 0.1.1");
  expect(bullets[1]).toContain("on styal 0.1.2");
  expect(opened.body).not.toContain("- `");
  expect(opened.body).not.toContain("[click](");
  expect(opened.body).not.toContain("<img");
  expect(opened.body).not.toContain("@everyone");
  expect(opened.body).not.toContain("\n- injected");
  const changed = reconcileStatusIssue(
    { number: 7, open: true, body: reconcileStatusIssue(null, failed, [], runUrl)!.body },
    run,
    [],
    runUrl,
  )!;
  expect(changed.comment?.split("\n").filter((line) => line.startsWith("- "))).toEqual(bullets);
});
