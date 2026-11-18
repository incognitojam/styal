import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useProjectPinOrder } from "../hooks/useProjectPinOrder";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock(import("../hooks/useThreadActions"), async (original) => {
  const actual = await original();
  return { ...actual, useThreadActions: vi.fn(actual.useThreadActions) };
});
vi.mock(import("../hooks/useProjectPinOrder"), async (original) => {
  const actual = await original();
  return { ...actual, useProjectPinOrder: vi.fn(actual.useProjectPinOrder) };
});
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const environmentId = EnvironmentId.make("local");

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

function clientSettings(mode: "normal" | "boring"): Disposable {
  const previous = getClientSettings();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: mode === "boring",
  });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(previous) };
}

function mockNewThread(projects: readonly Project[]) {
  const defaultProjectRef = {
    environmentId: projects[0]!.environmentId,
    projectId: projects[0]!.id,
  };
  const startThread = vi.fn().mockResolvedValue(null);
  vi.mocked(useProjects).mockReturnValue(projects);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef,
    defaultProjectFallbackReady: true,
    handleNewThread: startThread,
    routeDraftId: null,
    routeThreadRef: null,
  });
  return { defaultProjectRef, startThread };
}

function renderSidebar() {
  return render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using _settings = clientSettings(scenario.mode);
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const { defaultProjectRef, startThread } = mockNewThread(projects);
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(defaultProjectRef);
    }
  });
});

describe("sidebar drag reorder", () => {
  // The dashed Active target shows while Active would be left empty, folders or not.
  it.each([
    {
      mode: "normal",
      folders: false,
      drag: "first",
      onto: "second",
      action: "reorder",
      activeTarget: true,
    },
    {
      mode: "boring",
      folders: false,
      drag: "first",
      onto: "second",
      action: "reorder",
      activeTarget: true,
    },
    {
      mode: "boring",
      folders: true,
      drag: "first",
      onto: "second",
      action: "reorder",
      activeTarget: false,
    },
    {
      mode: "boring",
      folders: true,
      drag: "open",
      onto: "first",
      action: "pin",
      activeTarget: true,
    },
  ] as const)(
    "$mode sidebar, folders=$folders: dragging $drag onto $onto does $action",
    async (scenario) => {
      using _settings = clientSettings(scenario.mode);
      using stack = new DisposableStack();
      const originalActions = vi.mocked(useThreadActions).getMockImplementation()!;
      stack.defer(() => vi.mocked(useThreadActions).mockImplementation(originalActions));
      const reorderPinnedThread = vi.fn().mockResolvedValue({ _tag: "Success" });
      const pinThread = vi.fn().mockResolvedValue({ _tag: "Success" });

      vi.mocked(useThreadActions).mockImplementation(() => ({
        ...originalActions(),
        reorderPinnedThread,
        pinThread,
      }));
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      const alpha = project("alpha");
      const thread = (id: string, pinnedAt: string | null) =>
        makeThreadFixture({
          id: ThreadId.make(id),
          environmentId,
          projectId: alpha.id,
          title: id,
          pinnedAt,
          pinOrderKey: pinnedAt === null ? null : id === "first" ? "a0" : "a1",
        });
      mockNewThread([alpha]);
      vi.mocked(useQuietThreadShells).mockReturnValue([
        thread("first", "2026-01-01T00:00:00.000Z"),
        thread("second", "2026-01-01T00:01:00.000Z"),
        ...(scenario.folders ? [thread("open", null)] : []),
      ]);
      vi.mocked(useServerConfigs).mockReturnValue(new Map([[environmentId, {} as never]]));
      vi.mocked(useConnectedEnvironmentIds).mockReturnValue([environmentId]);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      await using screen = await renderSidebar();

      const row = screen.container.querySelector<HTMLElement>(
        `[data-thread-item="${environmentId}:${scenario.drag}"]`,
      );
      expect(row).not.toBeNull();
      const target = screen.container.querySelector<HTMLElement>(
        `[data-thread-item="${environmentId}:${scenario.onto}"]`,
      )!;
      const fromRect = row!.getBoundingClientRect();
      const ontoRect = target.getBoundingClientRect();
      const startY = fromRect.top + fromRect.height / 2;
      const endY = ontoRect.top + ontoRect.height / 2;
      const pointer = (type: string, clientY: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: fromRect.left + fromRect.width / 2,
          clientY,
        });
      await act(() => row!.dispatchEvent(pointer("pointerdown", startY)));
      await act(() => document.dispatchEvent(pointer("pointermove", startY + 10)));

      expect(row!.classList.contains("z-20")).toBe(true);
      await act(() => document.dispatchEvent(pointer("pointermove", endY)));
      const placeholder = screen.container.querySelector<HTMLElement>(
        '[data-testid="sidebar-active-placeholder"]',
      );
      expect(
        placeholder !== null &&
          placeholder.style.visibility !== "hidden" &&
          placeholder.querySelector(".border-dashed") !== null,
      ).toBe(scenario.activeTarget);
      await act(() => document.dispatchEvent(pointer("pointerup", endY)));
      if (scenario.action === "reorder") {
        await vi.waitFor(() =>
          expect(reorderPinnedThread).toHaveBeenCalledWith(
            { environmentId, threadId: ThreadId.make("first") },
            expect.any(String),
          ),
        );
        expect(reorderPinnedThread.mock.calls[0]![1] > "a1").toBe(true);
      } else {
        await vi.waitFor(() =>
          expect(pinThread).toHaveBeenCalledWith(
            { environmentId, threadId: ThreadId.make("open") },
            expect.anything(),
          ),
        );
      }
    },
  );

  it("pins a project by dragging its folder header above the pinned projects divider", async () => {
    using _settings = clientSettings("boring");
    using stack = new DisposableStack();
    const originalPinOrder = vi.mocked(useProjectPinOrder).getMockImplementation()!;
    stack.defer(() => vi.mocked(useProjectPinOrder).mockImplementation(originalPinOrder));
    const reorderPinnedProjects = vi.fn().mockResolvedValue({ _tag: "Success" });
    vi.mocked(useProjectPinOrder).mockImplementation(() => ({
      ...originalPinOrder(),
      reorderPinnedProjects,
    }));
    vi.mocked(readEnvironmentScope).mockReturnValue(true);
    const alpha = { ...project("alpha"), pinnedAt: "2026-01-01T00:00:00.000Z", pinOrderKey: "a0" };
    const beta = project("beta");
    mockNewThread([alpha, beta]);
    vi.mocked(useQuietThreadShells).mockReturnValue(
      [alpha, beta].map((owner) =>
        makeThreadFixture({
          id: ThreadId.make(`${owner.title}-thread`),
          environmentId,
          projectId: owner.id,
          title: `${owner.title} thread`,
        }),
      ),
    );
    vi.mocked(useServerConfigs).mockReturnValue(new Map([[environmentId, {} as never]]));
    vi.mocked(useConnectedEnvironmentIds).mockReturnValue([environmentId]);
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    await using screen = await renderSidebar();

    const folderButton = (title: string) =>
      [
        ...screen.container.querySelectorAll<HTMLElement>(
          '[data-testid="sidebar-project-folder"] button[aria-expanded]',
        ),
      ].find((button) => button.textContent?.includes(title))!;
    const betaButton = folderButton("beta");
    const fromRect = betaButton.getBoundingClientRect();
    const alphaRect = folderButton("alpha").getBoundingClientRect();
    const pointer = (type: string, clientY: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: fromRect.left + fromRect.width / 2,
        clientY,
      });
    const startY = fromRect.top + fromRect.height / 2;
    const endY = alphaRect.top + 4;
    await act(() => betaButton.dispatchEvent(pointer("pointerdown", startY)));
    await act(() => document.dispatchEvent(pointer("pointermove", startY - 10)));
    await act(() => document.dispatchEvent(pointer("pointermove", endY)));
    await expect
      .element(screen.getByText("Pinned projects above", { exact: true }))
      .toBeInTheDocument();
    await act(() => document.dispatchEvent(pointer("pointerup", endY)));

    await vi.waitFor(() => expect(reorderPinnedProjects).toHaveBeenCalledOnce());
    const [orderedGroups] = reorderPinnedProjects.mock.calls[0]!;
    expect(orderedGroups.map((group: { displayName: string }) => group.displayName)).toEqual([
      "beta",
      "alpha",
    ]);
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});
