import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { AtomRegistry } from "effect/reactivity";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { expect, it, vi } from "vite-plus/test";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "@t3tools/client-runtime/state/shell";

import { fakeTimers, stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  shell: {} as EnvironmentShellState,
  settings: {} as typeof DEFAULT_CLIENT_SETTINGS,
  play: vi.fn(),
  navigate: vi.fn(),
  settingsListeners: new Set<() => void>(),
}));
const atoms = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    shell: Atom.make<unknown>(null),
    environmentIds: Atom.make<ReadonlyArray<string>>(["test-environment"]),
  };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: { ...actual.environmentShell, stateValueAtom: (() => atoms.shell) as never },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      environmentIdsAtom: atoms.environmentIds as never,
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  getClientSettings: (() => state.settings) as never,
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.play,
  // The dock and taskbar badge has its own test; it would redraw the page favicon here.
  setNotificationBadge: vi.fn(),
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const notifications: {
  title: string;
  options: NotificationOptions;
  click?: () => void;
  close: ReturnType<typeof vi.fn>;
}[] = [];
const threadId = ThreadId.make("test-thread");
const runId = RunId.make("test-run");
const requestedAt = DateTime.makeUnsafe("2026-09-30T11:59:00Z");
const completedAt = DateTime.makeUnsafe("2026-09-30T12:00:00Z");
function snapshot(
  completed: boolean,
  extra: Partial<OrchestrationV2ThreadShell> = {},
): EnvironmentShellState {
  return {
    ...EMPTY_SHELL_STATE,
    status: "live",
    error: Option.none(),
    snapshot: Option.some({
      schemaVersion: 1,
      snapshotSequence: 1,
      projects: [],
      archivedThreads: [],
      threads: [
        {
          ...makeThreadProjectionFixture().thread,
          id: threadId,
          title: "Synthetic task",
          latestRunId: runId,
          activeRunId: completed ? null : runId,
          status: completed ? "completed" : "running",
          latestRunRequestedAt: requestedAt,
          latestRunStartedAt: requestedAt,
          latestRunCompletedAt: completed ? completedAt : null,
          pendingRuntimeRequest: null,
          latestVisibleMessage: null,
          latestUserMessageAt: null,
          hasActionableProposedPlan: false,
          itemCount: 0,
          visibleItemCount: 0,
          updatedAt: completedAt,
          ...extra,
        },
      ],
    }),
  };
}
function setup() {
  state.settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    notificationMode: "notifications-and-sound",
    completionSound: "avanti",
    inputSound: "t3-input",
    approvalSound: "t3-completion",
  };
  state.shell = snapshot(false);
  state.play.mockReset();
  state.navigate.mockReset();
  state.settingsListeners.clear();
  notifications.length = 0;
  const stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  // System notifications are only shown while the app is in the background.
  stack.use(vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"));
  stack.use(vi.spyOn(document, "hasFocus").mockReturnValue(false));
  stack.use(
    stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        close = vi.fn();
        click?: () => void;
        constructor(
          readonly title: string,
          readonly options: NotificationOptions,
        ) {
          notifications.push(this);
        }
        addEventListener(_event: string, listener: () => void) {
          this.click = listener;
        }
      },
    ),
  );
  let started = false;
  return {
    render: async () => {
      registry.set(atoms.shell, state.shell);
      if (started) {
        for (const listener of state.settingsListeners) listener();
        return;
      }
      started = true;
      const router = { state: { matches: [] }, navigate: state.navigate };
      stack.defer(startThreadNotifications(registry, router as never));
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it("alerts once for a live completion using the persisted sample and opens its environment/thread", async () => {
  await using app = setup();
  await app.render();
  using _timers = fakeTimers();
  expect(notifications).toHaveLength(0);
  state.shell = snapshot(true);
  await app.render();
  state.shell = snapshot(true);
  await app.render();
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(state.play).toHaveBeenCalledExactlyOnceWith("completion", expect.any(Function), "avanti");
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.title).toBe("Thread completed");
  notifications[0]?.click?.();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: EnvironmentId.make("test-environment"), threadId },
  });
});

it.each(["off", "notifications", "sound", "notifications-and-sound"] as const)(
  "honors %s for input and approval transitions",
  async (mode) => {
    await using app = setup();
    state.settings = { ...state.settings, notificationMode: mode };
    await app.render();
    state.shell = snapshot(false, {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input",
        createdAt: completedAt,
      },
    });
    await app.render();
    state.shell = snapshot(false, {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("approval"),
        kind: "command",
        createdAt: completedAt,
      },
    });
    await app.render();
    expect(state.play).toHaveBeenCalledTimes(
      mode === "sound" || mode === "notifications-and-sound" ? 2 : 0,
    );
    if (mode === "sound" || mode === "notifications-and-sound") {
      expect(state.play.mock.calls.map(([kind, , sound]) => ({ kind, sound }))).toEqual([
        { kind: "input", sound: "t3-input" },
        { kind: "input", sound: "t3-completion" },
      ]);
    }
    expect(notifications.map((n) => n.title)).toEqual(
      mode === "notifications" || mode === "notifications-and-sound"
        ? ["Input needed", "Approval needed"]
        : [],
    );
  },
);

it("does not replay initial, reconnect, or archived completions", async () => {
  await using app = setup();
  state.shell = snapshot(true);
  await app.render();
  state.shell = { ...state.shell, status: "synchronizing", snapshot: Option.none() };
  await app.render();
  state.shell = snapshot(true);
  await app.render();
  state.shell = snapshot(false);
  await app.render();
  state.shell = snapshot(true, {
    archivedAt: DateTime.makeUnsafe("2026-09-30T12:01:00Z"),
    latestRunCompletedAt: DateTime.makeUnsafe("2026-09-30T12:01:00Z"),
  });
  await app.render();
  expect(state.play).not.toHaveBeenCalled();
  expect(notifications).toHaveLength(0);
});
