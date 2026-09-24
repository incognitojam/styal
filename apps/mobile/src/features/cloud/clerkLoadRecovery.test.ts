import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CLERK_LOAD_RETRY_INITIAL_DELAY_MS,
  CLERK_LOAD_RETRY_MAX_DELAY_MS,
  CLERK_REQUEST_TIMEOUT_MS,
  limitClerkRequestDuration,
  retryFailedClerkLoads,
} from "./clerkLoadRecovery";

type Listener = (status: string) => void;

// Mirrors @clerk/react's IsomorphicClerk: each failed load emits "error" again.
function fakeClerk(outcomes: ReadonlyArray<"error" | "ready">) {
  const listeners = new Set<Listener>();
  const remaining = [...outcomes];
  const clerk = {
    loaded: false,
    status: "loading",
    loadAttempts: 0,
    on: (_event: "status", listener: Listener) => void listeners.add(listener),
    off: (_event: "status", listener: Listener) => void listeners.delete(listener),
    loadHeadlessClerk: () => {
      clerk.loadAttempts += 1;
      clerk.emit(remaining.shift() ?? "ready");
    },
    emit: (status: string) => {
      clerk.status = status;
      clerk.loaded = status === "ready";
      for (const listener of listeners) listener(status);
    },
  };
  return clerk;
}

function appActiveSource() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    becomeActive: () => {
      for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("retryFailedClerkLoads", () => {
  it("reloads after each failure with capped exponential backoff until Clerk loads", () => {
    const clerk = fakeClerk(["error", "error", "error", "error", "error"]);
    const appActive = appActiveSource();
    retryFailedClerkLoads(clerk, appActive.subscribe);

    clerk.emit("error");
    const delays = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      vi.advanceTimersByTime(delay - 1);
      expect(clerk.loadAttempts).toBe(index);
      vi.advanceTimersByTime(1);
      expect(clerk.loadAttempts).toBe(index + 1);
    }

    expect(clerk.loaded).toBe(true);
    vi.advanceTimersByTime(CLERK_LOAD_RETRY_MAX_DELAY_MS * 2);
    expect(clerk.loadAttempts).toBe(delays.length);
  });

  it("retries a load that had already failed before it subscribed", () => {
    const clerk = fakeClerk([]);
    clerk.emit("error");
    retryFailedClerkLoads(clerk, appActiveSource().subscribe);

    vi.advanceTimersByTime(CLERK_LOAD_RETRY_INITIAL_DELAY_MS);
    expect(clerk.loadAttempts).toBe(1);
    expect(clerk.loaded).toBe(true);
  });

  it("runs a pending retry immediately when the app returns to the foreground", () => {
    const clerk = fakeClerk([]);
    const appActive = appActiveSource();
    retryFailedClerkLoads(clerk, appActive.subscribe);

    appActive.becomeActive();
    expect(clerk.loadAttempts).toBe(0);

    clerk.emit("error");
    appActive.becomeActive();
    expect(clerk.loadAttempts).toBe(1);
    expect(clerk.loaded).toBe(true);

    vi.advanceTimersByTime(CLERK_LOAD_RETRY_MAX_DELAY_MS);
    appActive.becomeActive();
    expect(clerk.loadAttempts).toBe(1);
  });

  it("stops retrying after cleanup", () => {
    const clerk = fakeClerk([]);
    const appActive = appActiveSource();
    const stop = retryFailedClerkLoads(clerk, appActive.subscribe);

    clerk.emit("error");
    stop();
    appActive.becomeActive();
    vi.advanceTimersByTime(CLERK_LOAD_RETRY_MAX_DELAY_MS);
    clerk.emit("error");
    vi.advanceTimersByTime(CLERK_LOAD_RETRY_MAX_DELAY_MS);
    expect(clerk.loadAttempts).toBe(0);
  });
});

describe("limitClerkRequestDuration", () => {
  function clerkWithRequestHooks() {
    const hooks: Array<(requestInit: { method?: string; signal?: AbortSignal | null }) => void> =
      [];
    return {
      hooks,
      __internal_onBeforeRequest: (hook: (typeof hooks)[number]) => void hooks.push(hook),
      prepare: (requestInit: { method?: string; signal?: AbortSignal | null }) => {
        for (const hook of hooks) hook(requestInit);
        return requestInit;
      },
    };
  }

  it("aborts GET requests that outlast the timeout and leaves writes unbounded", () => {
    const clerk = clerkWithRequestHooks();
    limitClerkRequestDuration(clerk);
    limitClerkRequestDuration(clerk);
    expect(clerk.hooks).toHaveLength(1);

    const get = clerk.prepare({ method: "GET" });
    const post = clerk.prepare({ method: "POST" });
    expect(post.signal).toBeUndefined();

    vi.advanceTimersByTime(CLERK_REQUEST_TIMEOUT_MS - 1);
    expect(get.signal?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(get.signal?.aborted).toBe(true);
  });

  it("keeps a caller-provided abort signal", () => {
    const clerk = clerkWithRequestHooks();
    limitClerkRequestDuration(clerk);
    const callerSignal = new AbortController().signal;

    expect(clerk.prepare({ method: "GET", signal: callerSignal }).signal).toBe(callerSignal);
  });
});
