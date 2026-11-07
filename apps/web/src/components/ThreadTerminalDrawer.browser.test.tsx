import { EMPTY_TERMINAL_SESSION_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, fakeTimers, render } from "../../test/render";
import type { GhosttyTerminalSurfaceOptions } from "../terminal/ghostty/surface";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const fixture = vi.hoisted(() => ({
  statusByThreadId: new Map<string, "running" | "exited">(),
  pendingSurfaces: [] as Array<() => void>,
  surfaceOptions: [] as Array<GhosttyTerminalSurfaceOptions>,
  writes: [] as Array<unknown>,
  writeResult: null as Promise<unknown> | null,
  terminalOutput: [] as Array<string>,
  connectionPhase: "connected" as "connected" | "reconnecting",
  connectionListeners: new Set<() => void>(),
}));

// Every surface method is a no-op returning an unsubscribe; `then` stays undefined so awaiting the
// surface resolves to it.
const fakeSurface = new Proxy(
  {
    input: document.createElement("textarea"),
    write: (data: string) => fixture.terminalOutput.push(data),
  },
  {
    get: (target, key) =>
      key === "then" ? undefined : key in target ? Reflect.get(target, key) : () => () => undefined,
  },
);
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: (_mount: HTMLElement, options: GhosttyTerminalSurfaceOptions) =>
      new Promise((resolve) => {
        fixture.surfaceOptions.push(options);
        fixture.pendingSurfaces.push(() => resolve(fakeSurface));
      }),
  },
}));
vi.mock("../state/terminalSessions", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const sessions = Atom.family((_environmentId: EnvironmentId) =>
    Atom.family((threadId: ThreadId) =>
      Atom.make({
        ...EMPTY_TERMINAL_SESSION_STATE,
        status: fixture.statusByThreadId.get(threadId) ?? "closed",
        version: 1,
      }),
    ),
  );
  return {
    attachedTerminalSessionAtom: (environmentId: EnvironmentId, terminal: { threadId: ThreadId }) =>
      sessions(environmentId)(terminal.threadId),
  };
});
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (input: unknown) => {
    if (command === "write") fixture.writes.push(input);
    return command === "write" && fixture.writeResult !== null
      ? await fixture.writeResult
      : { _tag: "Success" };
  },
}));
vi.mock("../state/presentation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentPresentation: () => {
      const phase = useSyncExternalStore(
        (listener) => {
          fixture.connectionListeners.add(listener);
          return () => fixture.connectionListeners.delete(listener);
        },
        () => fixture.connectionPhase,
      );
      return {
        presentation: {
          entry: { target: { label: "Test server" } },
          connection: { phase },
        },
      };
    },
  };
});
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/server", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../state/terminal", () => ({ terminalEnvironment: { write: "write", resize: {} } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("./preview/openTerminalLinkInPreview", () => ({ openTerminalLinkInPreview: () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    useClientSettings: <T,>(select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select(DEFAULT_CLIENT_SETTINGS),
  };
});

function Drawer(props: {
  threadRef: ScopedThreadRef;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
}) {
  return (
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={props.threadRef.threadId}
      cwd="/repo"
      height={240}
      terminalIds={["term-1"]}
      activeTerminalId="term-1"
      terminalGroups={[{ id: "group-1", terminalIds: ["term-1"] }]}
      activeTerminalGroupId="group-1"
      onSplitTerminal={() => {}}
      onSplitTerminalVertical={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={props.onCloseTerminal}
      onHeightChange={() => {}}
      onAddTerminalContext={() => {}}
      keybindings={[]}
    />
  );
}

function setup() {
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("thread-b"),
  };
  fixture.statusByThreadId = new Map([
    [original.threadId, "exited"],
    [other.threadId, "running"],
  ]);
  fixture.pendingSurfaces = [];
  fixture.surfaceOptions = [];
  fixture.writes = [];
  fixture.writeResult = null;
  fixture.terminalOutput = [];
  fixture.connectionPhase = "connected";
  fixture.connectionListeners.clear();
  fakeSurface.input.readOnly = false;
  return { original, other };
}

it("closes an exited terminal on its own thread after navigating to one reusing its ID", async () => {
  const { original, other } = setup();
  const onCloseTerminal = vi.fn();
  await using screen = await render(
    <Drawer threadRef={original} onCloseTerminal={onCloseTerminal} />,
  );
  using _timers = fakeTimers();
  // The exit is seen once the surface loads, and its close waits for the next task.
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await screen.rerender(<Drawer threadRef={other} onCloseTerminal={onCloseTerminal} />);
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(onCloseTerminal.mock.calls).toEqual([["term-1", original]]);
});

it("pauses terminal input while reconnecting and resumes without replaying it", async () => {
  const { other } = setup();
  const onCloseTerminal = vi.fn();
  await using _screen = await render(
    <Drawer threadRef={other} onCloseTerminal={onCloseTerminal} />,
  );
  await act(async () => fixture.pendingSurfaces.shift()?.());
  const surface = fixture.surfaceOptions[0]!;
  let finishWrite!: (value: unknown) => void;
  fixture.writeResult = new Promise((resolve) => {
    finishWrite = resolve;
  });
  await act(async () => surface.onData("echo before\r"));
  expect(fixture.writes).toHaveLength(1);

  await act(() => {
    fixture.connectionPhase = "reconnecting";
    for (const listener of fixture.connectionListeners) listener();
  });
  await act(async () => {
    finishWrite(AsyncResult.failure(Cause.fail(new Error("Test server is not connected."))));
    surface.onData("echo offline\r");
    surface.onData("\u0003");
  });
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.terminalOutput).toEqual([]);
  expect(fakeSurface.input.readOnly).toBe(true);

  await act(() => {
    fixture.writeResult = null;
    fixture.connectionPhase = "connected";
    for (const listener of fixture.connectionListeners) listener();
  });
  expect(fakeSurface.input.readOnly).toBe(false);
  await act(async () => surface.onData("echo after\r"));
  expect(fixture.writes).toEqual([
    {
      environmentId: other.environmentId,
      input: { threadId: other.threadId, terminalId: "term-1", data: "echo before\r" },
    },
    {
      environmentId: other.environmentId,
      input: { threadId: other.threadId, terminalId: "term-1", data: "echo after\r" },
    },
  ]);
  expect(onCloseTerminal).not.toHaveBeenCalled();
});
