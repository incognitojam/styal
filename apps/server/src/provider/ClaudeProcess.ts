// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

// The watcher stops the CLI group when its server-owned pipe closes, including on server death.
export const spawnClaudeProcessGroup: SpawnClaudeChild = (command, args, options) =>
  NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", CLAUDE_GROUP_WATCH_SCRIPT, "t3-claude", command, ...args],
    {
      ...options,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
    },
  );

/** Enough of the end of stderr to hold a stack trace or a login error. */
const STDERR_TAIL_LIMIT = 4096;

export interface ClaudeProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ClaudeProcessObserver {
  readonly onSpawn?: (info: { readonly pid: number | undefined }) => void;
  readonly onStderr?: (text: string) => void;
  readonly onExit?: (
    info: ClaudeProcessExit & {
      readonly pid: number | undefined;
      readonly stderrTail: string;
    },
  ) => void;
}

export type SpawnClaudeChild = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions,
) => NodeChildProcess.ChildProcess;

/** The CLI process behind one session, as far as the SDK has spawned it. */
export interface ClaudeProcessHandle {
  readonly pid: () => number | undefined;
  readonly exited: () => ClaudeProcessExit | undefined;
  /** Settles when the CLI exits. Stays pending if the SDK never spawned it. */
  readonly exit: Promise<ClaudeProcessExit>;
  readonly stderrTail: () => string;
  readonly kill: (signal: NodeJS.Signals) => boolean;
}

/**
 * Builds the `spawnClaudeCodeProcess` option for one SDK query. The SDK's
 * own transport neither reports the CLI's exit nor keeps its stderr once the
 * stream has ended, so a session that dies looks like "Claude runtime stream
 * failed." with nothing to go on. Spawning the CLI here keeps a handle to
 * the process and its stderr tail while leaving the SDK in charge of stdin,
 * stdout and shutdown signalling.
 */
export function makeClaudeProcessSpawner(input?: {
  readonly observer?: ClaudeProcessObserver;
  readonly spawn?: SpawnClaudeChild;
  /**
   * Starts the CLI as the leader of its own process group. When the CLI exits it
   * stops the MCP servers it started, but not their children: a plugin's
   * `bun run start` wrapper dies and its `bun server.ts` keeps running. Those stay
   * in the CLI's group, so the rest of the group gets SIGKILL once the CLI exits.
   * Commands the agent runs through its Bash tool start their own groups.
   */
  readonly processGroup?: boolean;
}): {
  readonly handle: ClaudeProcessHandle;
  readonly spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
} {
  const spawn =
    input?.spawn ?? (input?.processGroup ? spawnClaudeProcessGroup : NodeChildProcess.spawn);
  const observer = input?.observer;
  let child: NodeChildProcess.ChildProcess | undefined;
  let exited: ClaudeProcessExit | undefined;
  let stderrTail = "";
  let resolveExit: (exit: ClaudeProcessExit) => void = () => undefined;
  const exit = new Promise<ClaudeProcessExit>((resolve) => {
    resolveExit = resolve;
  });

  const spawnClaudeCodeProcess = (options: SpawnOptions): SpawnedProcess => {
    // Same spawn call as the SDK's built-in transport, so only observation
    // changes: piped stdio, the SDK's forwarded abort signal, no console
    // window on Windows.
    const process = spawn(options.command, options.args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
      windowsHide: true,
      ...(input?.processGroup ? { detached: true } : {}),
    });
    child = process;
    // The SDK's abort of `signal` surfaces as an AbortError here; the exit
    // that follows is what matters. A spawn failure also reaches the SDK
    // through the process's missing stdout, so nothing is lost by ignoring it.
    process.on("error", () => undefined);
    process.stderr?.setEncoding("utf8");
    process.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      observer?.onStderr?.(chunk);
    });
    process.once("exit", (code, signal) => {
      if (input?.processGroup && process.pid !== undefined) {
        try {
          signalProcessGroup(process.pid, "SIGKILL");
        } catch {
          // The group is already empty.
        }
      }
      exited = { code, signal };
      observer?.onExit?.({ code, signal, pid: process.pid, stderrTail });
      resolveExit(exited);
    });
    observer?.onSpawn?.({ pid: process.pid });
    if (process.stdin === null || process.stdout === null) {
      throw new Error("Claude CLI spawned without piped stdio.");
    }
    // A ChildProcess is the SDK's documented SpawnedProcess; only its
    // nullable stdio keeps the types apart, and both pipes exist here.
    return process as NodeChildProcess.ChildProcess & {
      readonly stdin: NonNullable<NodeChildProcess.ChildProcess["stdin"]>;
      readonly stdout: NonNullable<NodeChildProcess.ChildProcess["stdout"]>;
    };
  };

  return {
    handle: {
      pid: () => child?.pid,
      exited: () => exited,
      exit,
      stderrTail: () => stderrTail,
      kill: (signal) => child?.kill(signal) ?? false,
    },
    spawnClaudeCodeProcess,
  };
}
