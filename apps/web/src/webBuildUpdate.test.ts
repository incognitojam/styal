// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { watchWebBuildUpdates } from "./webBuildUpdate";

const manifest = (buildId: string) => Response.json({ buildId });
const fetchBuild = vi.fn<typeof fetch>();
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  fetchBuild.mockReset();
  fetchBuild.mockImplementation(async () => manifest("build-a"));
  vi.stubGlobal("fetch", fetchBuild);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("web build update checks", () => {
  it("detects a deployment and clears the notice if it rolls back to the loaded build", async () => {
    const onChange = vi.fn();
    stop = watchWebBuildUpdates("build-a", onChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(fetchBuild).toHaveBeenCalledWith(new URL("/build.json", window.location.origin), {
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });

    fetchBuild.mockResolvedValue(manifest("build-b"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenLastCalledWith("build-b");

    fetchBuild.mockResolvedValue(manifest("build-c"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenLastCalledWith("build-c");

    fetchBuild.mockResolvedValue(manifest("build-a"));
    await vi.advanceTimersByTimeAsync(60_000);
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
      const onChange = vi.fn();
      fetchBuild.mockResolvedValue(manifest("build-b"));
      stop = watchWebBuildUpdates("build-a", onChange);
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenLastCalledWith("build-b");
      onChange.mockClear();

      fetchBuild.mockResolvedValue(response());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onChange).not.toHaveBeenCalled();

      fetchBuild.mockResolvedValue(manifest("build-a"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onChange).toHaveBeenLastCalledWith(null);
    },
  );

  it("retries network failures and checks again on focus", async () => {
    const onChange = vi.fn();
    fetchBuild.mockRejectedValueOnce(new TypeError("offline"));
    stop = watchWebBuildUpdates("build-a", onChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).not.toHaveBeenCalled();

    fetchBuild.mockResolvedValue(manifest("build-b"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenLastCalledWith("build-b");
    expect(fetchBuild).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden or offline and resumes immediately when usable", async () => {
    const onChange = vi.fn();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const online = vi.spyOn(navigator, "onLine", "get");
    visibility.mockReturnValue("hidden");
    stop = watchWebBuildUpdates("build-a", onChange);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchBuild).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchBuild).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchBuild).toHaveBeenCalledTimes(1);

    online.mockReturnValue(false);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchBuild).toHaveBeenCalledTimes(1);

    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchBuild).toHaveBeenCalledTimes(2);

    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchBuild).toHaveBeenCalledTimes(2);
  });

  it("does not overlap requests and ignores a result after disposal", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    fetchBuild.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const onChange = vi.fn();
    stop = watchWebBuildUpdates("build-a", onChange);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(fetchBuild).toHaveBeenCalledTimes(1);

    const signal = fetchBuild.mock.calls[0]?.[1]?.signal;
    stop();
    expect(signal?.aborted).toBe(true);
    resolveFetch(manifest("build-b"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onChange).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    expect(fetchBuild).toHaveBeenCalledTimes(1);
  });

  it("times out a hung request and retries later", async () => {
    fetchBuild.mockImplementationOnce(
      (_, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const onChange = vi.fn();
    stop = watchWebBuildUpdates("build-a", onChange);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();

    fetchBuild.mockResolvedValue(manifest("build-b"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenLastCalledWith("build-b");
    expect(fetchBuild).toHaveBeenCalledTimes(2);
  });
});
