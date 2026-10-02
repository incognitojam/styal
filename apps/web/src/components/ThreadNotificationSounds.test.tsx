import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";

const state = vi.hoisted(() => ({
  shell: {} as EnvironmentShellState,
  settings: {} as typeof DEFAULT_CLIENT_SETTINGS,
  play: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.shell }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({}),
}));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => state.settings,
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(state.settings),
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => [EnvironmentId.make("test-environment")],
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => null } }));
vi.mock("../threadNotifications", async (original) => ({
  ...(await original<typeof import("../threadNotifications")>()),
  playNotificationSound: state.play,
  // The dock and taskbar badge has its own test; it draws on a canvas this stub lacks.
  setNotificationBadge: vi.fn(),
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;
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
function render() {
  act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}
beforeEach(() => {
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
  notifications.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", {
    focus: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
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
  );
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("alerts once for a live completion using the persisted sample and opens its environment/thread", () => {
  render();
  expect(notifications).toHaveLength(0);
  state.shell = snapshot(true);
  render();
  state.shell = snapshot(true);
  render();
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
  (mode) => {
    state.settings = { ...state.settings, notificationMode: mode };
    render();
    state.shell = snapshot(false, {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input",
        createdAt: completedAt,
      },
    });
    render();
    state.shell = snapshot(false, {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("approval"),
        kind: "command",
        createdAt: completedAt,
      },
    });
    render();
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

it("does not replay initial, reconnect, or archived completions", () => {
  state.shell = snapshot(true);
  render();
  state.shell = { ...state.shell, status: "synchronizing", snapshot: Option.none() };
  render();
  state.shell = snapshot(true);
  render();
  state.shell = snapshot(false);
  render();
  state.shell = snapshot(true, {
    archivedAt: DateTime.makeUnsafe("2026-09-30T12:01:00Z"),
    latestRunCompletedAt: DateTime.makeUnsafe("2026-09-30T12:01:00Z"),
  });
  render();
  expect(state.play).not.toHaveBeenCalled();
  expect(notifications).toHaveLength(0);
});
