import { describe, expect, it } from "vite-plus/test";
import { failureBody, healthAction, syncNightlyHealth } from "./nightly-health.ts";
import { classifyReport, issueLabels, postDiscord } from "./issue-routing.ts";

const published = {
  results: { prepare: "success", release: "success", publish_cli: "success" },
  workflowDryRun: false,
  npmRequired: true,
};
const run = {
  html_url: "https://example.test/run/1",
  head_sha: "abc123",
  runId: "1",
  runAttempt: 2,
  ...published,
};

function fixture(numbers: number[] = []) {
  const open = new Set(numbers);
  const comments = new Map<number, object[]>();
  const calls: { method: string; path: string; body?: object }[] = [];
  const request = async <T>(method: string, path: string, body?: object): Promise<T> => {
    calls.push({ method, path, ...(body ? { body } : {}) });
    let result: unknown = {};
    if (path.includes("/issues?")) result = [...open].map((number) => ({ number }));
    else if (path.includes("/jobs?")) result = { jobs: [] };
    else if (path.includes("/comments")) {
      const number = Number(path.split("/").at(-2));
      if (method === "GET") result = comments.get(number) ?? [];
      else comments.set(number, [...(comments.get(number) ?? []), body!]);
    } else if (method === "POST" && path.endsWith("/issues")) {
      open.add(7);
      result = { number: 7 };
    } else if (method === "PATCH") open.delete(Number(path.split("/").at(-1)));
    return result as T;
  };
  return {
    open,
    comments,
    calls,
    options: { request, repo: "example/project", run, dryRun: false },
  };
}

describe("nightly health", () => {
  it.each([
    ["failure, no issue", { ...published, results: { prepare: "failure" } }, [], "would open"],
    [
      "failure, one issue",
      { ...published, results: { release: "failure" } },
      [{ number: 1 }],
      "would skip",
    ],
    [
      "failure, two issues",
      { ...published, results: { publish_cli: "failure" } },
      [{ number: 1 }, { number: 2 }],
      "would skip",
    ],
    ["published, one issue", published, [{ number: 1 }], "would close"],
    ["published, two issues", published, [{ number: 1 }, { number: 2 }], "would close"],
    ["published, no issue", published, [], "nothing to close"],
    [
      "cancelled even with failure",
      { ...published, results: { prepare: "failure", release: "cancelled" } },
      [{ number: 1 }],
      "ignored",
    ],
    [
      "prepare succeeded, release skipped",
      { ...published, results: { prepare: "success", release: "skipped" } },
      [{ number: 1 }],
      "ignored",
    ],
    [
      "successful workflow dry run",
      { ...published, workflowDryRun: true },
      [{ number: 1 }],
      "ignored",
    ],
    [
      "failed workflow dry run",
      { ...published, workflowDryRun: true, results: { prepare: "failure" } },
      [],
      "would open",
    ],
    [
      "npm enabled but skipped",
      { ...published, results: { release: "success", publish_cli: "skipped" } },
      [{ number: 1 }],
      "ignored",
    ],
    [
      "npm disabled",
      { ...published, npmRequired: false, results: { release: "success", publish_cli: "skipped" } },
      [{ number: 1 }],
      "would close",
    ],
    ["incomplete", { ...published, results: { release: "in_progress" } }, [], "ignored"],
    [
      "rejected request",
      { ...published, results: { prepare: "skipped", release: "skipped" } },
      [{ number: 1 }],
      "ignored",
    ],
    [
      "notification failure only",
      { ...published, results: { ...published.results, notify_failure: "failure" } },
      [],
      "nothing to close",
    ],
  ] as const)("%s", async (_name, outcome, issues, expected) => {
    expect(healthAction(outcome, [...issues])).toBe(expected);
    if (expected === "ignored") {
      const state = fixture();
      expect(await syncNightlyHealth({ ...state.options, run: { ...run, ...outcome } })).toBe(
        "ignored",
      );
      expect(state.calls).toEqual([]);
    }
  });

  it("renders hostile names and annotations as bounded inert text", () => {
    const name = "odd\n`job` @example-user Fixes #42 <details>…</details>";
    const body = failureBody(
      run,
      [
        { name, conclusion: "failure", steps: [{ name: "step\r\n```", conclusion: "failure" }] },
        { name: "x".repeat(1000), conclusion: "failure" },
        { name: "Linux", conclusion: "success" },
      ],
      { [name]: "@example-user Fixes #42 <details>…</details>\n" + "x".repeat(1000) },
    );
    expect(body).toContain("`odd 'job' @example-user Fixes #42 <details>…</details>`");
    expect(body).toContain("`step '''`");
    expect(body).toContain(" — `@example-user Fixes #42 <details>…</details> ");
    expect(body).not.toContain("x".repeat(501));
    expect(body.split("\n")).toHaveLength(5);
    expect(body).not.toContain("Linux");
    expect(issueLabels(classifyReport(body))).toEqual(["needs-triage"]);
  });

  it("opens once across seven failures, leaves two issues on failure, and recovers both once", async () => {
    const state = fixture();
    const options = { ...state.options, run: { ...run, results: { release: "failure" } } };
    for (let failure = 0; failure < 7; failure++) await syncNightlyHealth(options);
    expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    state.open.add(8);
    expect(await syncNightlyHealth(options)).toBe("would skip");
    expect([...state.open]).toEqual([7, 8]);
    expect(await syncNightlyHealth(state.options)).toBe("would close");
    expect([...state.open]).toEqual([]);
    expect(state.comments.get(7)).toEqual([{ body: `Fork Nightly recovered: ${run.html_url}` }]);
    expect(state.comments.get(8)).toHaveLength(1);
    const before = state.calls.length;
    expect(await syncNightlyHealth(state.options)).toBe("nothing to close");
    expect(state.calls.slice(before)).toHaveLength(1);
    expect(state.calls.at(-1)?.path).toContain("/issues?");
  });

  it("does not repeat a recovery comment after closure fails and the attempt is retried", async () => {
    const state = fixture([7, 8]);
    let failClose = true;
    const request: typeof state.options.request = async (method, path, body) => {
      if (method === "PATCH" && failClose) {
        failClose = false;
        throw new Error("Close failed");
      }
      return state.options.request(method, path, body);
    };
    await expect(syncNightlyHealth({ ...state.options, request })).rejects.toThrow("Close failed");
    await syncNightlyHealth({ ...state.options, request, run: { ...run, runAttempt: 3 } });
    expect(state.comments.get(7)).toHaveLength(1);
    expect(state.comments.get(8)).toHaveLength(1);
    expect([...state.open]).toEqual([]);
  });

  it.each(["failure", "recovery"])("keeps %s dry runs read-only", async (kind) => {
    const state = fixture(kind === "recovery" ? [7] : []);
    await syncNightlyHealth({
      ...state.options,
      dryRun: true,
      run: kind === "failure" ? { ...run, results: { release: "failure" } } : run,
    });
    expect(state.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each(["GET", "POST", "PATCH"])("propagates issue API %s failures", async (failedMethod) => {
    const state = fixture(failedMethod === "PATCH" ? [7] : []);
    const request: typeof state.options.request = async (method, path, body) => {
      if (method === failedMethod) throw new Error("GitHub unavailable");
      return state.options.request(method, path, body);
    };
    await expect(
      syncNightlyHealth({
        ...state.options,
        request,
        run: failedMethod === "PATCH" ? run : { ...run, results: { release: "failure" } },
      }),
    ).rejects.toThrow("GitHub unavailable");
  });

  it.each([403, 500])(
    "warns for Discord HTTP %s without hiding successful issue creation",
    async (status) => {
      const state = fixture();
      const warnings: string[] = [];
      const result = await syncNightlyHealth({
        ...state.options,
        run: { ...run, results: { release: "failure" } },
        warn: (message) => warnings.push(message),
        announce: async () => {
          await postDiscord(
            "https://example.invalid/webhook",
            { allowed_mentions: { parse: [] }, embeds: [] },
            async () => new Response(null, { status }),
          );
        },
      });
      expect(result).toBe("opened #7");
      expect([...state.open]).toEqual([7]);
      expect(warnings).toEqual(["Discord issue announcement could not be delivered."]);
    },
  );

  it.each([true, false])(
    "uses only the first failure annotation when readable=%s",
    async (readable) => {
      const state = fixture();
      const request: typeof state.options.request = async <T>(
        method: string,
        path: string,
        body?: object,
      ): Promise<T> => {
        if (path.includes("/jobs?"))
          return {
            jobs: [
              {
                name: "__proto__",
                conclusion: "failure",
                check_run_url: "https://api.github.com/repos/example/project/check-runs/1",
                steps: [{ name: "Notarize", conclusion: "failure" }],
              },
            ],
          } as T;
        if (path.includes("/annotations?")) {
          if (!readable) throw new Error("Forbidden");
          return [
            { annotation_level: "warning", message: "Do not include" },
            { annotation_level: "failure", message: "Agreement expired\nExtra output" },
          ] as T;
        }
        return state.options.request(method, path, body);
      };
      const output = await syncNightlyHealth({
        ...state.options,
        request,
        run: { ...run, results: { release: "failure" } },
        dryRun: true,
      });
      expect(output).toContain("`__proto__`: `Notarize`");
      expect(output.includes("Agreement expired")).toBe(readable);
      expect(output).not.toContain("Extra output");
      expect(output).not.toContain("Do not include");
    },
  );
});
