import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../test/render";
import { watchWebBuildUpdates } from "./webBuildUpdate";

const manifest = (buildId: string) => Response.json({ buildId });
const fetchBuild = vi.fn<typeof fetch>();

// Chromium reads a response body on real tasks, which fake timers never run.
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
    await vi.advanceTimersByTimeAsync(0);
  }
}

function setup() {
  using stack = new DisposableStack();
  stack.use(fakeTimers());
  stack.use(vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"));
  stack.use(vi.spyOn(navigator, "onLine", "get").mockReturnValue(true));
  fetchBuild.mockReset();
  fetchBuild.mockImplementation(async () => manifest("build-a"));
  stack.use(stubGlobal("fetch", fetchBuild));
  return stack.move();
}

function watch(...args: Parameters<typeof watchWebBuildUpdates>) {
  const stop = watchWebBuildUpdates(...args);
  return { stop, [Symbol.dispose]: stop };
}

describe("web build update checks", () => {
  it("detects a deployment and clears the notice if it rolls back to the loaded build", async () => {
    using _setup = setup();
    const onChange = vi.fn();
    using _watcher = watch("build-a", onChange);
    await advance(0);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(fetchBuild).toHaveBeenCalledWith(new URL("/build.json", window.location.origin), {
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });

    fetchBuild.mockResolvedValue(manifest("build-b"));
    await advance(60_000);
    expect(onChange).toHaveBeenLastCalledWith("build-b");

    fetchBuild.mockResolvedValue(manifest("build-c"));
    await advance(60_000);
    expect(onChange).toHaveBeenLastCalledWith("build-c");

    fetchBuild.mockResolvedValue(manifest("build-a"));
    await advance(60_000);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it.each([
    ["missing manifest", () => new Response("Not found", { status: 404 })],
    [
      "SPA fallback",
      () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    ],
    [
      "malformed JSON",
      () => new Response("{", { headers: { "content-type": "application/json" } }),
    ],
    ["missing ID", () => Response.json({})],
    ["invalid ID", () => Response.json({ buildId: 42 })],
    ["empty ID", () => manifest(" ")],
  ])(
    "ignores %s without erasing a known update and recovers on the next check",
    async (_, response) => {
      using _setup = setup();
      const onChange = vi.fn();
      fetchBuild.mockResolvedValue(manifest("build-b"));
      using _watcher = watch("build-a", onChange);
      await advance(0);
      expect(onChange).toHaveBeenLastCalledWith("build-b");
      onChange.mockClear();

      fetchBuild.mockResolvedValue(response());
      await advance(60_000);
      expect(onChange).not.toHaveBeenCalled();

      fetchBuild.mockResolvedValue(manifest("build-a"));
      await advance(60_000);
      expect(onChange).toHaveBeenLastCalledWith(null);
    },
  );

  it("retries network failures and checks again on focus", async () => {
    using _setup = setup();
    const onChange = vi.fn();
    fetchBuild.mockRejectedValueOnce(new TypeError("offline"));
    using _watcher = watch("build-a", onChange);
    await advance(0);
    expect(onChange).not.toHaveBeenCalled();

    fetchBuild.mockResolvedValue(manifest("build-b"));
    window.dispatchEvent(new Event("focus"));
    await advance(0);
    expect(onChange).toHaveBeenLastCalledWith("build-b");
    expect(fetchBuild).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden or offline and resumes immediately when usable", async () => {
    using _setup = setup();
    const onChange = vi.fn();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const online = vi.spyOn(navigator, "onLine", "get");
    visibility.mockReturnValue("hidden");
    using _watcher = watch("build-a", onChange);
    await advance(120_000);
    expect(fetchBuild).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(0);
    expect(fetchBuild).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(120_000);
    expect(fetchBuild).toHaveBeenCalledTimes(1);

    online.mockReturnValue(false);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(120_000);
    expect(fetchBuild).toHaveBeenCalledTimes(1);

    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await advance(0);
    expect(fetchBuild).toHaveBeenCalledTimes(2);

    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    await advance(120_000);
    expect(fetchBuild).toHaveBeenCalledTimes(2);
  });

  it("does not overlap requests and ignores a result after disposal", async () => {
    using _setup = setup();
    let resolveFetch: (response: Response) => void = () => {};
    fetchBuild.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const onChange = vi.fn();
    using watcher = watch("build-a", onChange);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(fetchBuild).toHaveBeenCalledTimes(1);

    const signal = fetchBuild.mock.calls[0]?.[1]?.signal;
    watcher.stop();
    expect(signal?.aborted).toBe(true);
    resolveFetch(manifest("build-b"));
    await advance(120_000);
    expect(onChange).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    expect(fetchBuild).toHaveBeenCalledTimes(1);
  });

  it("times out a hung request and retries later", async () => {
    using _setup = setup();
    fetchBuild.mockImplementationOnce(
      (_, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const onChange = vi.fn();
    using _watcher = watch("build-a", onChange);
    await advance(10_000);
    expect(onChange).not.toHaveBeenCalled();

    fetchBuild.mockResolvedValue(manifest("build-b"));
    await advance(60_000);
    expect(onChange).toHaveBeenLastCalledWith("build-b");
    expect(fetchBuild).toHaveBeenCalledTimes(2);
  });
});
