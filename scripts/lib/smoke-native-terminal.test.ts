// @effect-diagnostics nodeBuiltinImport:off - Exercises native terminal process lifetime on the real host.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { expect, it } from "@effect/vitest";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This subprocess integration test exercises the actual host platform.
const platform = process.platform;

it("verifies a native terminal and exits without retaining its output worker", () => {
  const scratch = NodeURL.fileURLToPath(new URL("../../.scratch/", import.meta.url));
  NodeFS.mkdirSync(scratch, { recursive: true });
  const project = NodeFS.mkdtempSync(`${scratch}nightly-terminal-test-`);
  try {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./smoke-native-terminal.mjs", import.meta.url)),
        NodeURL.fileURLToPath(new URL("../../apps/server/", import.meta.url)),
        project,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: "",
          HOME: project,
          USERPROFILE: project,
          TEMP: project,
          TMPDIR: project,
          ...(platform === "win32"
            ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }
            : {}),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally {
    NodeFS.rmSync(project, { recursive: true, force: true });
  }
}, 15_000);
