import { describe, expect, it } from "vite-plus/test";
import { failureBody, healthAction, syncNightlyHealth } from "./nightly-health.ts";
import { classifyReport, issueLabels } from "./issue-routing.ts";

describe("nightly health", () => {
  it.each([
    ["failure", [], "would open"],
    ["failure", [{ number: 1 }], "would skip"],
    ["success", [], "nothing to close"],
    ["success", [{ number: 1 }], "would close"],
    ["cancelled", [], "ignored"],
    [null, [], "ignored"],
  ] as const)("decides %s with %j", (conclusion, issues, expected) => {
    expect(healthAction(conclusion, [...issues])).toBe(expected);
  });

  it("reports every failed step without successful job output or app-report labels", () => {
    const body = failureBody(
      {
        html_url: "https://example.test/run/1",
        head_sha: "abc123",
        conclusion: "failure",
        name: "Fork Nightly",
      },
      [
        {
          name: "macOS",
          conclusion: "failure",
          steps: [{ name: "Notarize", conclusion: "failure" }],
        },
        {
          name: "CLI",
          conclusion: "failure",
          steps: [
            { name: "Build", conclusion: "failure" },
            { name: "Cleanup", conclusion: "failure" },
          ],
        },
        { name: "Linux", conclusion: "success" },
        { name: "Windows", conclusion: "failure" },
      ],
      { macOS: "Agreement expired" },
    );
    expect(body).toBe(
      "Run: https://example.test/run/1\nCommit: abc123\n\n- macOS: Notarize — Agreement expired\n- CLI: Build\n- CLI: Cleanup\n- Windows: failed step unavailable",
    );
    expect(classifyReport(body)).toBe("other");
    expect(issueLabels(classifyReport(body))).toEqual(["needs-triage"]);
  });

  it("opens once across seven failures, then comments and closes once on recovery", async () => {
    let conclusion = "failure";
    let open = false;
    const writes: { method: string; path: string; body?: object }[] = [];
    let announcements = 0;
    const request = async <T>(method: string, path: string, body?: object): Promise<T> => {
      if (method !== "GET") writes.push({ method, path, ...(body ? { body } : {}) });
      let result: unknown = {};
      if (path.endsWith("/actions/runs/1"))
        result = {
          name: "Fork Nightly",
          html_url: "https://example.test/run/1",
          head_sha: "abc123",
          conclusion,
        };
      else if (path.includes("/issues?")) result = open ? [{ number: 7 }] : [];
      else if (path.includes("/jobs?")) result = { jobs: [] };
      else if (method === "POST" && path.endsWith("/issues")) {
        open = true;
        result = { number: 7 };
      } else if (method === "PATCH") open = false;
      return result as T;
    };
    const options = {
      request,
      repo: "example/project",
      runId: "1",
      dryRun: false,
      announce: async () => {
        announcements++;
      },
    };
    for (let failure = 0; failure < 7; failure++) await syncNightlyHealth(options);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({
      title: "Fork Nightly is failing",
      labels: ["nightly-failure", "bug", "needs-triage"],
    });
    expect(announcements).toBe(1);
    conclusion = "success";
    expect(await syncNightlyHealth(options)).toBe("would close");
    expect(writes.slice(1)).toEqual([
      {
        method: "POST",
        path: "/repos/example/project/issues/7/comments",
        body: { body: "Fork Nightly recovered: https://example.test/run/1" },
      },
      {
        method: "PATCH",
        path: "/repos/example/project/issues/7",
        body: { state: "closed", state_reason: "completed" },
      },
    ]);
    expect(await syncNightlyHealth(options)).toBe("nothing to close");
    expect(writes).toHaveLength(3);
    open = true;
    expect(await syncNightlyHealth({ ...options, dryRun: true })).toBe("would close");
    open = false;
    conclusion = "failure";
    expect(await syncNightlyHealth({ ...options, dryRun: true })).toContain("would open");
    expect(writes).toHaveLength(3);
  });
  it.each([true, false])(
    "uses only the first failure annotation when readable=%s",
    async (readable) => {
      const request = async <T>(method: string, path: string): Promise<T> => {
        expect(method).toBe("GET");
        let result: unknown;
        if (path.includes("/issues?")) result = [];
        else if (path.includes("/jobs?"))
          result = {
            jobs: [
              {
                name: "macOS",
                conclusion: "failure",
                check_run_url: "https://api.github.com/repos/example/project/check-runs/1",
                steps: [{ name: "Notarize", conclusion: "failure" }],
              },
            ],
          };
        else if (path.includes("/annotations?")) {
          if (!readable) throw Object.assign(new Error("Forbidden"), { status: 403 });
          result = [
            { annotation_level: "warning", message: "Do not include" },
            { annotation_level: "failure", message: "Agreement expired\nExtra output" },
          ];
        } else
          result = {
            name: "Fork Nightly",
            html_url: "https://example.test/run/1",
            head_sha: "abc123",
            conclusion: "failure",
          };
        return result as T;
      };
      const output = await syncNightlyHealth({
        request,
        repo: "example/project",
        runId: "1",
        dryRun: true,
      });
      expect(output).toContain("would open");
      expect(output).toContain("macOS: Notarize");
      expect(output.includes("Agreement expired")).toBe(readable);
      expect(output).not.toContain("Extra output");
      expect(output).not.toContain("Do not include");
    },
  );
});
