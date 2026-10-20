import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useThreadTerminalActions } from "./useThreadTerminalActions";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
  allowed: new Set<string>(),
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: ((ref: ScopedThreadRef | null) =>
    ref ? { ...ref, projectId: "project", worktreePath: null } : null) as never,
  useProject: (() => ({ workspaceRoot: "/synthetic/project" })) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (environmentId: string) => state.allowed.has(environmentId),
}));
vi.mock(import("../../state/terminal"), async (original) => ({
  ...(await original()),
  terminalEnvironment: { open: "open", write: "write", close: "close" } as never,
}));
vi.mock(import("../../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useKnownTerminalSessions: () => [],
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "open" | "write" | "close") => state[command]) as never,
}));

const original: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const other: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-b"),
  threadId: ThreadId.make("thread-b"),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let actions: ReturnType<typeof useThreadTerminalActions>;
function Probe({ target }: { target: ScopedThreadRef }) {
  const currentActions = useThreadTerminalActions(target);
  useLayoutEffect(() => {
    actions = currentActions;
  });
  return null;
}

function setup() {
  state.allowed = new Set([original.environmentId, other.environmentId]);
  state.open.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.close.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

it.each(["open", "paste"])(
  "writes to the initiating thread after delayed %s and navigation",
  async (delay) => {
    setup();
    const ready = deferred<ReturnType<typeof AsyncResult.success<void>>>();
    const paste = deferred<string>();
    if (delay === "open") state.open.mockReturnValue(ready.promise);
    await using screen = await render(<Probe target={original} />);
    const retained = actions;
    const launched = retained.launchTerminal({ place: () => {}, terminalId: "term-1" })!;
    const runScript = (async () => {
      await launched.result;
      const data = delay === "paste" ? await paste.promise : "echo synthetic\r";
      return retained.writeToTerminal(original, launched.terminalId, data);
    })();
    await screen.rerender(<Probe target={other} />);
    await act(async () => {
      ready.resolve(AsyncResult.success(undefined));
      paste.resolve("echo synthetic\r");
      await runScript;
    });
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: original.environmentId,
        input: expect.objectContaining({ threadId: original.threadId, terminalId: "term-1" }),
      }),
    );
    expect(state.write).toHaveBeenCalledExactlyOnceWith({
      environmentId: original.environmentId,
      input: { threadId: original.threadId, terminalId: "term-1", data: "echo synthetic\r" },
    });
  },
);

it("rechecks the captured environment's permission before a delayed write", async () => {
  setup();
  await using screen = await render(<Probe target={original} />);
  const retained = actions;
  await screen.rerender(<Probe target={other} />);
  state.allowed.delete(original.environmentId);
  expect(retained.writeToTerminal(original, "term-1", "echo synthetic\r")).toBeNull();
  expect(state.write).not.toHaveBeenCalled();
});

it.each([true, false])(
  "keeps a failed close's exit fallback on the initiating thread, allowed=%s",
  async (allowed) => {
    setup();
    const closed = deferred<ReturnType<typeof AsyncResult.failure>>();
    state.close.mockReturnValue(closed.promise);
    await using screen = await render(<Probe target={original} />);
    const retained = actions;
    retained.closeTerminalSession(original, "term-1");
    await screen.rerender(<Probe target={other} />);
    if (!allowed) state.allowed.delete(original.environmentId);
    await act(async () => {
      closed.resolve(AsyncResult.failure(Cause.fail(new Error("synthetic close failure"))));
    });
    expect(state.close).toHaveBeenCalledExactlyOnceWith({
      environmentId: original.environmentId,
      input: { threadId: original.threadId, terminalId: "term-1", deleteHistory: true },
    });
    if (allowed) {
      expect(state.write).toHaveBeenCalledExactlyOnceWith({
        environmentId: original.environmentId,
        input: { threadId: original.threadId, terminalId: "term-1", data: "exit\n" },
      });
    } else {
      expect(state.write).not.toHaveBeenCalled();
    }
  },
);
