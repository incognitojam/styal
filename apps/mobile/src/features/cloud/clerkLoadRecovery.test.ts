import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CLERK_LOAD_RETRY_INITIAL_DELAY_MS,
  CLERK_LOAD_RETRY_MAX_DELAY_MS,
  CLERK_REQUEST_TIMEOUT_MS,
  CLERK_TOKEN_READ_TIMEOUT_MS,
  limitClerkRequestDuration,
  recoverableClerkTokenCache,
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

describe("recoverableClerkTokenCache", () => {
  function storedTokenCache() {
    return {
      getToken: vi.fn(async (_key: string): Promise<string | null> => "synthetic-client-token"),
      saveToken: vi.fn(async (_key: string, _token: string) => {}),
      clearToken: vi.fn(async (_key: string) => {}),
    };
  }

  it("reads a saved sign-in and clears the timeout once storage responds", async () => {
    const cache = storedTokenCache();
    const wrapped = recoverableClerkTokenCache(cache);

    await expect(wrapped.getToken("client-token")).resolves.toBe("synthetic-client-token");
    expect(cache.getToken).toHaveBeenCalledWith("client-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a stalled read without signing out or clearing saved credentials", async () => {
    const cache = storedTokenCache();
    cache.getToken.mockImplementationOnce(() => new Promise(() => {}));
    const wrapped = recoverableClerkTokenCache(cache);
    const read = expect(wrapped.getToken("client-token")).rejects.toThrow(
      "Reading the saved styal Link sign-in timed out.",
    );

    await vi.advanceTimersByTimeAsync(CLERK_TOKEN_READ_TIMEOUT_MS);
    await read;
    expect(cache.clearToken).not.toHaveBeenCalled();
    expect(cache.saveToken).not.toHaveBeenCalled();
    // The timed-out promise is not cached, so a new attempt reads storage again.
    await expect(wrapped.getToken("client-token")).resolves.toBe("synthetic-client-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the failed-load retry restore the same saved sign-in", async () => {
    const cache = storedTokenCache();
    cache.getToken.mockImplementationOnce(() => new Promise(() => {}));
    const wrapped = recoverableClerkTokenCache(cache);
    const clerk = fakeClerk([]);
    const onLoadFailed = vi.fn();
    let restoredToken: string | null | undefined;
    clerk.loadHeadlessClerk = () => {
      clerk.loadAttempts += 1;
      void wrapped.getToken("client-token").then(
        (token) => {
          restoredToken = token;
          clerk.emit("ready");
        },
        () => clerk.emit("error"),
      );
    };
    const stop = retryFailedClerkLoads(clerk, appActiveSource().subscribe, onLoadFailed);

    clerk.loadHeadlessClerk();
    await vi.advanceTimersByTimeAsync(CLERK_TOKEN_READ_TIMEOUT_MS);
    expect(onLoadFailed).toHaveBeenCalledOnce();
    expect(clerk.loaded).toBe(false);

    await vi.advanceTimersByTimeAsync(CLERK_LOAD_RETRY_INITIAL_DELAY_MS);
    expect(clerk.loaded).toBe(true);
    expect(restoredToken).toBe("synthetic-client-token");
    expect(clerk.loadAttempts).toBe(2);
    expect(cache.clearToken).not.toHaveBeenCalled();
    stop();
  });

  it("ignores a late completion from the timed-out read", async () => {
    const cache = storedTokenCache();
    let finishRead: (token: string) => void = () => {};
    cache.getToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const wrapped = recoverableClerkTokenCache(cache);
    const read = expect(wrapped.getToken("client-token")).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(CLERK_TOKEN_READ_TIMEOUT_MS);
    await read;
    finishRead("obsolete-client-token");
    await expect(wrapped.getToken("client-token")).resolves.toBe("synthetic-client-token");
    expect(cache.saveToken).not.toHaveBeenCalled();
    expect(cache.clearToken).not.toHaveBeenCalled();
  });

  it("preserves genuine missing-token and storage-error results", async () => {
    const cache = storedTokenCache();
    cache.getToken.mockResolvedValueOnce(null);
    const wrapped = recoverableClerkTokenCache(cache);
    await expect(wrapped.getToken("client-token")).resolves.toBeNull();
    const error = new Error("Synthetic storage failure");
    cache.getToken.mockRejectedValueOnce(error);
    await expect(wrapped.getToken("client-token")).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
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

  it("reports each failed load, including one that failed before it subscribed", () => {
    const clerk = fakeClerk(["error", "ready"]);
    clerk.emit("error");
    const onLoadFailed = vi.fn();
    retryFailedClerkLoads(clerk, appActiveSource().subscribe, onLoadFailed);
    expect(onLoadFailed).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CLERK_LOAD_RETRY_INITIAL_DELAY_MS);
    expect(onLoadFailed).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(CLERK_LOAD_RETRY_MAX_DELAY_MS);
    expect(clerk.loaded).toBe(true);
    expect(onLoadFailed).toHaveBeenCalledTimes(2);
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
