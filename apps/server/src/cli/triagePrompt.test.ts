// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { buildTriageContext, buildTriageLaunchPrompt, TRIAGE_PLAYBOOK } from "./triagePrompt.ts";

it("stays byte-identical to .github/triage/PLAYBOOK.md", () => {
  // Older releases fetch the repository playbook.
  const canonicalPath = NodePath.join(
    import.meta.dirname,
    "../../../../.github/triage/PLAYBOOK.md",
  );
  assert.equal(TRIAGE_PLAYBOOK, NodeFS.readFileSync(canonicalPath, "utf8"));
});

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // Windows .cmd shims cannot carry multiline argv.
  const launch = buildTriageLaunchPrompt(String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});

it("context file labels the CLI version as the CLI's, not the user's build", () => {
  const context = buildTriageContext({
    generatedAt: "2026-09-24T00:00:00.000Z",
    cliVersion: "0.0.42",
    os: "linux x64 (7.2.0)",
    nodeVersion: "v26.8.2",
    launchedAs: "npx @styal/cli triage",
    server: "running (pid 42, http://127.0.0.1:3773, version 0.0.43-nightly.20260923.2173)",
    paths: {
      stateDir: "/home/u/.@styal/cli/userdata",
      dbPath: "/home/u/.@styal/cli/userdata/state.sqlite",
      settingsPath: "/home/u/.@styal/cli/userdata/settings.json",
      logsDir: "/home/u/.@styal/cli/userdata/logs",
      serviceLogPath: "/home/u/.@styal/cli/userdata/logs/boot-service.log",
      desktopBackendLogGlob: "/home/u/.@styal/cli/userdata/logs/server-child*.log*",
      serverTracePath: "/home/u/.@styal/cli/userdata/logs/server.trace.ndjson",
      providerEventLogPath: "/home/u/.@styal/cli/userdata/logs/provider/events.log",
      terminalLogsDir: "/home/u/.@styal/cli/userdata/logs/terminals",
      providerStatusCacheDir: "/home/u/.@styal/cli/caches",
      secretsDir: "/home/u/.@styal/cli/userdata/secrets",
      sourceCacheDir: "/home/u/.@styal/cli/source",
    },
  });
  assert.notInclude(context, "Installed version");
  assert.notInclude(context, "Release tag");
  assert.include(context, "- Triage CLI version: 0.0.42 (");
  assert.include(context, "version 0.0.43-nightly.20260923.2173");
});
