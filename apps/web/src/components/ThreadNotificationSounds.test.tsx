import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  TurnId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
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
  useEnvironments: () => ({ environments: [{ environmentId: "test-environment" }] }),
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => null } }));
vi.mock("../threadNotifications", async (original) => ({
  ...(await original<typeof import("../threadNotifications")>()),
  playNotificationSound: state.play,
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
const turnId = TurnId.make("test-turn");
function snapshot(completed: boolean, extra = {}): EnvironmentShellState {
  return {
    status: "live",
    error: Option.none(),
    snapshot: Option.some({
      snapshotSequence: 1,
      projects: [],
      updatedAt: "2026-09-30T12:00:00Z",
      threads: [
        {
          id: threadId,
          projectId: ProjectId.make("test-project"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          pullRequests: [],
          createdAt: "2026-09-30T12:00:00Z",
          updatedAt: "2026-09-30T12:00:00Z",
          settledAt: null,
          settledOverride: null,
          latestUserMessageAt: null,
          hasActionableProposedPlan: false,
          title: "Synthetic task",
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          backgroundLiveness: null,
          session: null,
          latestTurn: {
            turnId,
            startedAt: "2026-09-30T11:59:00Z",
            requestedAt: "2026-09-30T11:59:00Z",
            assistantMessageId: null,
            state: completed ? "completed" : "running",
            completedAt: completed ? "2026-09-30T12:00:00Z" : null,
          },
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
  vi.stubGlobal("window", { focus: vi.fn() });
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
    state.shell = snapshot(false, { hasPendingUserInput: true });
    render();
    state.shell = snapshot(false, { hasPendingApprovals: true });
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
    archivedAt: "2026-09-30T12:01:00Z",
    latestTurn: { turnId, state: "completed", completedAt: "2026-09-30T12:01:00Z" },
  });
  render();
  expect(state.play).not.toHaveBeenCalled();
  expect(notifications).toHaveLength(0);
});
