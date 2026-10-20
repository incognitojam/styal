import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";

import { render, stubGlobal, type Screen } from "../../test/render";

const state = vi.hoisted(() => ({
  shell: {} as EnvironmentShellState,
  settings: {} as typeof DEFAULT_CLIENT_SETTINGS,
  play: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.shell) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => ({})) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  getClientSettings: (() => state.settings) as never,
  useClientSettings: ((select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(state.settings)) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => [EnvironmentId.make("test-environment")]) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.play,
  // The dock and taskbar badge has its own test; it would redraw the page favicon here.
  setNotificationBadge: vi.fn(),
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

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
  notifications.length = 0;
  const stack = new AsyncDisposableStack();
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
  let screen: Screen | undefined;
  return {
    render: async () => {
      if (screen) await screen.rerender(<ThreadNotificationCoordinator />);
      else screen = stack.use(await render(<ThreadNotificationCoordinator />));
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it("alerts once for a live completion using the persisted sample and opens its environment/thread", async () => {
  await using app = setup();
  await app.render();
  expect(notifications).toHaveLength(0);
  state.shell = snapshot(true);
  await app.render();
  state.shell = snapshot(true);
  await app.render();
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
