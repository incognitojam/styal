// @vitest-environment jsdom
import { act, useCallback, useEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const appListeners = new Set<(state: string) => void>();
  const state = { focused: true, app: "active" };
  return {
    state,
    listeners,
    appListeners,
    invalidate: vi.fn(),
    refresh: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focus: (focused: boolean) => {
      state.focused = focused;
      for (const listener of listeners) listener();
    },
    app: (app: string) => {
      state.app = app;
      for (const listener of appListeners) listener(app);
    },
  };
});
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    const focused = useSyncExternalStore(harness.subscribe, () => harness.state.focused);
    useEffect(useCallback(() => (focused ? callback() : undefined), [focused, callback]));
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.state.app;
    },
    addEventListener: (_: string, listener: (state: string) => void) => {
      harness.appListeners.add(listener);
      return {
        remove: () => {
          harness.appListeners.delete(listener);
        },
      };
    },
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomRefresh: () => harness.refresh }));
vi.mock("../../state/pull-requests", () => ({
  composerPullRequests: { detail: () => null, invalidate: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.invalidate }));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: Record<string, unknown>) => {
    const { environmentId, ...input } = params;
    return { environmentId, input };
  },
}));

import { usePullRequestMergeCommitRefresh } from "./usePullRequestMergeCommitRefresh";

const params = {
  environmentId: "environment",
  projectId: "project",
  repository: "acme/web",
  number: 7,
};
function Probe({ enabled }: { enabled: boolean }) {
  usePullRequestMergeCommitRefresh(params, enabled);
  return null;
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  harness.state.focused = true;
  harness.state.app = "active";
  harness.invalidate.mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reads fresh host detail while focused, including merged results, and stops when hidden", async () => {
  await act(async () => root.render(<Probe enabled />));
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(harness.invalidate).toHaveBeenCalledExactlyOnceWith({
    environmentId: "environment",
    input: {
      reference: { projectId: "project", repository: "acme/web", number: 7 },
      scope: "detail",
    },
  });
  expect(harness.refresh).toHaveBeenCalledOnce();
  await act(async () => harness.app("background"));
  await act(async () => vi.advanceTimersByTime(120_000));
  expect(harness.refresh).toHaveBeenCalledOnce();
  await act(async () => harness.app("active"));
  expect(harness.refresh).toHaveBeenCalledTimes(2);
  await act(async () => harness.focus(false));
  await act(async () => vi.advanceTimersByTime(120_000));
  expect(harness.refresh).toHaveBeenCalledTimes(2);
  expect(harness.appListeners.size).toBe(0);
  await act(async () => harness.focus(true));
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(harness.refresh).toHaveBeenCalledTimes(3);
  await act(async () => root.render(<Probe enabled={false} />));
  await act(async () => vi.advanceTimersByTime(120_000));
  expect(harness.refresh).toHaveBeenCalledTimes(3);
});

it("does not overlap host requests or refresh a route left during an in-flight read", async () => {
  let resolve: () => void = () => {};
  harness.invalidate.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<Probe enabled />));
  await act(async () => vi.advanceTimersByTime(180_000));
  expect(harness.invalidate).toHaveBeenCalledOnce();
  expect(harness.refresh).not.toHaveBeenCalled();
  await act(async () => harness.focus(false));
  await act(async () => resolve());
  expect(harness.refresh).not.toHaveBeenCalled();
});
