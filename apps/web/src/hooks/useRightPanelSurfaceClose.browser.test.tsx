import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useRightPanelSurfaceClose } from "./useRightPanelSurfaceClose";

const state = vi.hoisted(() => ({
  close: vi.fn(),
  confirm: vi.fn(),
  allowed: new Set<string>(),
}));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: () => null,
  useProject: () => null,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (environmentId: string) => state.allowed.has(environmentId),
  useEnvironmentScope: (environmentId: string | null) =>
    environmentId !== null && state.allowed.has(environmentId),
}));
vi.mock(import("../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useKnownTerminalSessions: () => [],
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.close) as never,
}));
vi.mock(import("./useTerminalCloseConfirmation"), async (original) => ({
  ...(await original()),
  useTerminalCloseConfirmation: () => state.confirm,
}));

const original: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const other: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-b"),
  threadId: ThreadId.make("thread-b"),
};
let root: Root | null = null;
let actions: ReturnType<typeof useRightPanelSurfaceClose>;
function Probe({ target }: { target: ScopedThreadRef }) {
  const currentActions = useRightPanelSurfaceClose({
    threadRef: target,
    terminalLabelsById: new Map(),
  });
  useLayoutEffect(() => {
    actions = currentActions;
  });
  return null;
}
async function render(target: ScopedThreadRef) {
  root ??= createRoot(document.createElement("div"));
  await act(() => root!.render(<Probe target={target} />));
  return actions;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = new Set([original.environmentId, other.environmentId]);
  state.close.mockResolvedValue({ _tag: "Success" });
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each(["confirmed", "cancelled", "revoked"])(
  "keeps a delayed %s close on its original thread",
  async (outcome) => {
    let confirm!: (confirmed: boolean) => void;
    state.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
    );
    for (const target of [original, other]) {
      useRightPanelStore.getState().openTerminal(target, "term-1");
      useTerminalUiStateStore.getState().ensureTerminal(target, "term-1");
    }
    const originalSurface = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      original,
    ).surfaces[0]!;
    const retained = await render(original);
    retained.closeSurface(originalSurface);
    await render(other);
    if (outcome === "revoked") state.allowed.delete(original.environmentId);
    await act(async () => {
      confirm(outcome !== "cancelled");
    });
    if (outcome === "confirmed") {
      expect(state.close).toHaveBeenCalledExactlyOnceWith({
        environmentId: original.environmentId,
        input: { threadId: original.threadId, terminalId: "term-1", deleteHistory: true },
      });
    } else {
      expect(state.close).not.toHaveBeenCalled();
    }
    const panels = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(panels, other).surfaces).toHaveLength(1);
    expect(selectThreadRightPanelState(panels, original).surfaces).toHaveLength(
      outcome === "cancelled" ? 1 : 0,
    );
  },
);
