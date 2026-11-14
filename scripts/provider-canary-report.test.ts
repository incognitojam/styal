// @effect-diagnostics nodeBuiltinImport:off -- Reads the report workflow to verify serialization.
import { expect, it } from "vite-plus/test";
import { collectRun, reconcileStatusIssue, syncCanaryReport } from "./provider-canary.ts";
import * as NodeFS from "node:fs";

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
    if (method === "PATCH" && fail) {
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
it("bounds hostile output as inline code and keeps state inert", () => {
  const hostile = "` @example-user Fixes #42 </code><!--\n" + "x".repeat(2000);
  const run = collectRun({
    plan: { plans: [{ kind: "blocked", provider: "codex", styal: "1", reason: hostile }] },
    outcomes: [],
    planResult: "success",
    recordResult: "skipped",
  });
  const update = reconcileStatusIssue(null, run, [], runUrl)!;
  expect(update.body).toContain("`**codex** on styal 1: ' @example-user Fixes #42 </code><!-- ");
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
