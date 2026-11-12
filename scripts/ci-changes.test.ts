// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const require = NodeModule.createRequire(import.meta.url);
const { decide, readWorkspace } = require("../.github/scripts/ci-changes.cjs");
const packages = readWorkspace();
const gates = (files: string[] | null, full = false) => decide(files, packages, full).outputs;
const suites = (outputs: ReturnType<typeof gates>) =>
  JSON.parse(outputs.workspace_matrix).include.map((entry: { suite: string }) => entry.suite);

describe("fork CI change gates", () => {
  it("keeps maintenance-only changes out of application lanes", () => {
    const output = gates([
      "docs/user/example.md",
      ".github/fork-features.yml",
      ".github/workflows/provider-canary.yml",
    ]);
    expect(output.typecheck).toBe(false);
    expect(output.release_smoke).toBe(false);
    expect(output.preview_calibration).toBe(false);
    expect(suites(output)).toEqual([]);
  });

  it("runs full lanes for unknown paths, manifests, unavailable diffs, and pushes", () => {
    for (const output of [
      gates(["new-root-file"]),
      gates(["apps/web/package.json"]),
      gates(null),
      gates(["docs/example.md"], true),
    ]) {
      for (const gate of [
        "typecheck",
        "build",
        "test_server",
        "test_device_windows",
        "preview_calibration",
        "release_smoke",
      ]) {
        expect(output[gate]).toBe(true);
      }
      expect(suites(output)).toEqual(["Web 1/2", "Web 2/2", "Clients", "E2E", "Other"]);
    }
  });

  it("runs only the scripts tests for intake state, CI helpers and ungated workflows", () => {
    for (const file of [
      ".github/upstream-tracked-prs.json",
      ".github/upstream-intake.json",
      ".github/scripts/release-changelog.sh",
      ".github/workflows/fork-nightly.yml",
    ]) {
      const { affected, outputs } = decide([file], packages, false);
      expect(affected).toEqual(["@t3tools/scripts"]);
      expect(outputs.build).toBe(false);
      expect(suites(outputs)).toEqual(["Other"]);
    }
  });

  it("runs every lane when a workflow this gate controls changes", () => {
    for (const file of [".github/workflows/fork-ci.yml", ".github/workflows/ci.yml"]) {
      expect(suites(gates([file]))).toEqual(["Web 1/2", "Web 2/2", "Clients", "E2E", "Other"]);
    }
  });

  it("builds and tests the clients that bundle third-party notices", () => {
    const output = gates(["third-party-licenses.config.json"]);
    expect(output.build).toBe(true);
    expect(suites(output)).toEqual(expect.arrayContaining(["Web 1/2", "Clients", "Other"]));
  });

  it("isolates web changes while retaining calibration, E2E, runtime and scripts tests", () => {
    const output = gates(["apps/web/src/example.ts"]);
    expect(output.test_server).toBe(false);
    expect(output.test_device_windows).toBe(false);
    expect(output.preview_calibration).toBe(true);
    expect(output.release_smoke).toBe(false);
    expect(suites(output)).toEqual(["Web 1/2", "Web 2/2", "E2E", "Other"]);
    const other = JSON.parse(output.workspace_matrix).include.find(
      (entry: { suite: string }) => entry.suite === "Other",
    );
    expect(other.filters).toContain("@t3tools/scripts");
    expect(other.filters).not.toContain("@t3tools/desktop");
  });

  it("keeps server shards, nightly upgrade, Windows devices and E2E together", () => {
    const output = gates(["apps/server/src/device/AgentDeviceTarget.ts"]);
    expect(output.test_server).toBe(true);
    expect(output.test_device_windows).toBe(true);
    expect(output.preview_calibration).toBe(false);
    expect(suites(output)).toEqual(["E2E", "Other"]);
  });

  it("runs tests that load the server's source in forks, apart from threaded packages", () => {
    for (const output of [
      gates(["apps/server/src/mcp/toolkits/pullRequests/tools.ts"]),
      gates(null),
    ]) {
      const other = JSON.parse(output.workspace_matrix).include.find(
        (entry: { suite: string }) => entry.suite === "Other",
      );
      expect(other.fork_filters).toBe("--filter '@t3tools/evals'");
      expect(other.filters).not.toContain("evals");
      expect(other.filters).toContain("scripts");
    }
    const web = JSON.parse(gates(["apps/web/src/example.ts"]).workspace_matrix).include.find(
      (entry: { suite: string }) => entry.suite === "Other",
    );
    expect(web.fork_filters).toBe("");
  });

  it("runs Rust in Web 2/2 and the scripts tests that read crate sources", () => {
    const output = gates(["native/resource-monitor/src/main.rs"]);
    expect(suites(output)).toEqual(["Web 2/2", "Other"]);
    expect(output.rust).toBe(true);
  });

  it("runs E2E for harness changes despite its missing workspace dependencies", () => {
    const output = gates(["e2e/support/environment.ts"]);
    expect(suites(output)).toEqual(["E2E"]);
    expect(output.test_server).toBe(false);
  });

  it("follows workspace dependencies across shared client and contract changes", () => {
    for (const file of [
      "packages/contracts/src/example.ts",
      "packages/client-runtime/src/example.ts",
    ]) {
      const output = gates([file]);
      expect(output.test_web_1).toBe(true);
      expect(output.test_clients).toBe(true);
      expect(output.test_e2e).toBe(true);
    }
  });
});

describe("required CI aggregate checks", () => {
  const workflow = parse(
    NodeFS.readFileSync(new URL("../.github/workflows/fork-ci.yml", import.meta.url), "utf8"),
  );
  it.each(["check", "test_server_required", "test_workspace_required", "release_smoke"])(
    "%s rejects cancellation, failure and unexplained skips",
    (job: string) => {
      const definition = workflow.jobs[job];
      const script = definition.steps[0].run;
      const output = gates([]);
      const results = Object.fromEntries(
        definition.needs.map((name: string) => [
          name,
          {
            result: name === "changes" || name === "lint" ? "success" : "skipped",
            outputs:
              name === "changes"
                ? Object.fromEntries(
                    Object.entries(output).map(([key, value]) => [key, String(value)]),
                  )
                : {},
          },
        ]),
      );
      const run = () => {
        const result = NodeChildProcess.spawnSync("bash", ["-c", script], {
          env: { ...process.env, RESULTS: JSON.stringify(results) },
        });
        expect(result.error).toBeUndefined();
        return result.status;
      };
      expect(run()).toBe(0);
      for (const name of definition.needs) {
        const original = results[name].result;
        for (const result of ["failure", "cancelled"]) {
          results[name].result = result;
          expect(run()).not.toBe(0);
        }
        results[name].result = original;
      }
      for (const gate of Object.keys(results.changes.outputs))
        results.changes.outputs[gate] = "true";
      expect(run()).not.toBe(0);
      for (const result of Object.values(results)) result.result = "success";
      expect(run()).toBe(0);
      for (const [name, result] of Object.entries(results)) {
        if (name !== "changes" && name !== "lint") result.result = "skipped";
      }
      results.changes.outputs = {};
      expect(run()).not.toBe(0);
    },
  );
});
