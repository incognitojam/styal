import { assert, describe, it } from "@effect/vitest";

import { makeClaudeProcessSpawner } from "./ClaudeProcess.ts";

const nodeScript = (source: string) => ({
  command: process.execPath,
  args: ["-e", source],
  cwd: process.cwd(),
  env: process.env,
  signal: new AbortController().signal,
});

describe("makeClaudeProcessSpawner", () => {
  it("reports the spawn, the stderr tail and the exit", async () => {
    const events: Array<string> = [];
    let exitInfo: { code: number | null; stderrTail: string } | undefined;
    const { handle, spawnClaudeCodeProcess } = makeClaudeProcessSpawner({
      observer: {
        onSpawn: ({ pid }) => events.push(`spawn:${typeof pid}`),
        onStderr: (text) => events.push(`stderr:${text.trim()}`),
        onExit: (info) => {
          exitInfo = info;
          events.push("exit");
        },
      },
    });

    assert.equal(handle.pid(), undefined);
    assert.equal(handle.exited(), undefined);
    const child = spawnClaudeCodeProcess(
      nodeScript(`process.stderr.write("boom\\n"); setTimeout(() => process.exit(3), 20)`),
    );
    assert.isNumber(handle.pid());
    assert.equal(child.exitCode, null);

    const exit = await handle.exit;
    assert.deepEqual(exit, { code: 3, signal: null });
    assert.deepEqual(handle.exited(), exit);
    assert.equal(handle.stderrTail(), "boom\n");
    assert.equal(exitInfo?.code, 3);
    assert.equal(exitInfo?.stderrTail, "boom\n");
    assert.equal(child.exitCode, 3);
    assert.deepEqual(events, ["spawn:number", "stderr:boom", "exit"]);
  });

  it("keeps only the end of a long stderr stream", async () => {
    const { handle, spawnClaudeCodeProcess } = makeClaudeProcessSpawner();
    spawnClaudeCodeProcess(
      nodeScript(`process.stderr.write("x".repeat(20000) + "END", () => process.exit(0))`),
    );
    await handle.exit;
    assert.equal(handle.stderrTail().length, 4096);
    assert.isTrue(handle.stderrTail().endsWith("END"));
  });

  it("kills the process on request", async () => {
    const { handle, spawnClaudeCodeProcess } = makeClaudeProcessSpawner();
    spawnClaudeCodeProcess(nodeScript(`setInterval(() => undefined, 1000)`));
    assert.isTrue(handle.kill("SIGTERM"));
    const exit = await handle.exit;
    assert.equal(exit.signal, "SIGTERM");
    assert.isFalse(handle.kill("SIGTERM"));
  });

  it("stays pending and refuses to kill when nothing was spawned", () => {
    const { handle } = makeClaudeProcessSpawner();
    assert.isFalse(handle.kill("SIGKILL"));
    assert.equal(handle.exited(), undefined);
  });
});
