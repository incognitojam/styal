// @effect-diagnostics nodeBuiltinImport:off - the script under test only uses Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it, onTestFinished } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The subprocess fixture uses POSIX shell signals on the actual test host.
it.runIf(process.platform !== "win32").each(["/bin/sh", "/bin/bash"])(
  "keeps the installer signal and output tail in the failure marker with %s",
  async (shell) => {
    const scratch = NodePath.resolve(import.meta.dirname, "../.scratch");
    NodeFS.mkdirSync(scratch, { recursive: true });
    const worktree = NodeFS.mkdtempSync(NodePath.join(scratch, "setup-signal-607-"));
    onTestFinished(() => NodeFS.rmSync(worktree, { recursive: true, force: true }));
    NodeFS.mkdirSync(NodePath.join(worktree, "scripts"));
    // Record the installer's PID before vp can replace its shell with exec.
    const setup = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "setup-worktree.ts"),
      "utf8",
    )
      .replace("shell: true,", `shell: ${JSON.stringify(shell)},`)
      .replace(
        "vp i --frozen-lockfile -- --yes",
        () => "echo $$ > installer.pid; vp i --frozen-lockfile -- --yes",
      );
    NodeFS.writeFileSync(NodePath.join(worktree, "scripts/setup-worktree.ts"), setup);
    NodeFS.mkdirSync(NodePath.join(worktree, "bin"));
    NodeFS.writeFileSync(
      NodePath.join(worktree, "bin/vp"),
      '#!/bin/sh\necho "synthetic installer failure"\nread -r installer_pid < installer.pid\nkill -TERM "$installer_pid"\n',
      { mode: 0o755 },
    );
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [NodePath.join(worktree, "scripts/setup-worktree.ts")],
          {
            env: {
              ...process.env,
              PATH: `${NodePath.join(worktree, "bin")}:${process.env.PATH}`,
              T3CODE_PROJECT_ROOT: worktree,
            },
            stdio: "ignore",
          },
        );
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      },
    );
    assert.deepEqual(result, { code: 1, signal: null });
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, ".styal/setup-done")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, ".styal/setup-running")));
    const failure = NodeFS.readFileSync(NodePath.join(worktree, ".styal/setup-failed"), "utf8");
    assert.include(failure, "Installer killed by signal SIGTERM.");
    assert.include(failure, "synthetic installer failure");
  },
);
