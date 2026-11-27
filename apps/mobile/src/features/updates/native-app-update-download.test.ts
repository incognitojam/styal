import { describe, expect, it, vi } from "vite-plus/test";

import {
  createNativeAppUpdateDownloader,
  type NativeAppUpdateDownloadEnvironment,
} from "./native-app-update-download";
import type { NativeAppUpdate } from "./native-app-updates";

const update: NativeAppUpdate = {
  tag: "android-1.4.0-20",
  version: "1.4.0",
  apkUrl: "https://github.com/incognitojam/styal/releases/download/android-1.4.0-20/styal.apk",
  apkSizeBytes: 100,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<NativeAppUpdateDownloadEnvironment> = {}) {
  const apk = { uri: "file:///cache/update.apk", exists: () => true, dispose: vi.fn() };
  const environment: NativeAppUpdateDownloadEnvironment = {
    download: vi.fn(async () => apk),
    install: vi.fn(async () => true),
    isForeground: async () => true,
    onFailure: vi.fn(),
    ...overrides,
  };
  return { apk, environment, downloader: createNativeAppUpdateDownloader(environment) };
}

describe("Android update download", () => {
  it("opens the downloaded APK once, retaining it when the installer closes", async () => {
    const { downloader, environment, apk } = fixture();
    const changed = vi.fn();
    const unsubscribe = downloader.subscribe(changed);
    await downloader.start(update);
    expect(environment.install).toHaveBeenCalledExactlyOnceWith(apk.uri);
    expect(downloader.getSnapshot()).toEqual({ status: "ready", tag: update.tag });
    expect(apk.dispose).not.toHaveBeenCalled();
    await downloader.start(update);
    expect(environment.download).toHaveBeenCalledTimes(1);
    expect(environment.install).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(changed).toHaveBeenCalled();
  });

  it("coalesces taps and progress updates, with cancellation discarding even a late completed download", async () => {
    const work = deferred<ReturnType<typeof fixture>["apk"]>();
    let signal!: AbortSignal;
    let progress!: (percent: number) => void;
    const { downloader, environment, apk } = fixture({
      download: vi.fn((_update, nextSignal, onProgress) => {
        signal = nextSignal;
        progress = onProgress;
        return work.promise;
      }),
    });
    const changed = vi.fn();
    downloader.subscribe(changed);
    const first = downloader.start(update);
    await downloader.start(update);
    progress(40.1);
    progress(40.9);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(downloader.getSnapshot()).toEqual({
      status: "downloading",
      tag: update.tag,
      percent: 40,
    });
    downloader.cancel();
    expect(signal.aborted).toBe(true);
    progress(100);
    work.resolve(apk);
    await first;
    expect(apk.dispose).toHaveBeenCalledOnce();
    expect(environment.install).not.toHaveBeenCalled();
    expect(environment.onFailure).not.toHaveBeenCalled();
    expect(downloader.getSnapshot()).toEqual({ status: "idle" });
  });

  it("allows retry after a canceled request rejects", async () => {
    const work = deferred<ReturnType<typeof fixture>["apk"]>();
    const { downloader, environment, apk } = fixture({ download: vi.fn(() => work.promise) });
    const first = downloader.start(update);
    downloader.cancel();
    work.reject(new Error("aborted"));
    await first;
    vi.mocked(environment.download).mockResolvedValue(apk);
    await downloader.start(update);
    expect(environment.download).toHaveBeenCalledTimes(2);
    expect(environment.install).toHaveBeenCalledExactlyOnceWith(apk.uri);
  });

  it("reports a download failure and retries instead of opening a partial APK", async () => {
    const { downloader, environment, apk } = fixture({
      download: vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    });
    await downloader.start(update);
    expect(downloader.getSnapshot()).toEqual({ status: "error", tag: update.tag });
    expect(environment.onFailure).toHaveBeenCalledOnce();
    expect(environment.install).not.toHaveBeenCalled();
    vi.mocked(environment.download).mockResolvedValue(apk);
    await downloader.start(update);
    expect(environment.install).toHaveBeenCalledExactlyOnceWith(apk.uri);
  });

  it("leaves a completed background download for an explicit install", async () => {
    const { downloader, environment, apk } = fixture({ isForeground: async () => false });
    await downloader.start(update);
    expect(downloader.getSnapshot()).toEqual({ status: "ready", tag: update.tag });
    expect(environment.install).not.toHaveBeenCalled();
    await downloader.start(update);
    expect(environment.install).toHaveBeenCalledExactlyOnceWith(apk.uri);
    expect(environment.download).toHaveBeenCalledOnce();
  });

  it("keeps the APK when install permission is denied, then retries permission without downloading", async () => {
    const { downloader, environment, apk } = fixture({ install: vi.fn(async () => false) });
    await downloader.start(update);
    expect(downloader.getSnapshot()).toEqual({
      status: "ready",
      tag: update.tag,
      message: "Allow installs from styal to continue",
    });
    vi.mocked(environment.install).mockResolvedValue(true);
    await downloader.start(update);
    expect(environment.download).toHaveBeenCalledOnce();
    expect(environment.install).toHaveBeenCalledTimes(2);
    expect(apk.dispose).not.toHaveBeenCalled();
  });

  it("keeps the install action after a handoff failure and prevents overlapping installers", async () => {
    const handoff = deferred<boolean>();
    const started = deferred<void>();
    const { downloader, environment } = fixture({
      install: vi.fn(() => {
        started.resolve();
        return handoff.promise;
      }),
    });
    const first = downloader.start(update);
    await started.promise;
    await downloader.start(update);
    handoff.reject(new Error("No installer"));
    await first;
    expect(environment.install).toHaveBeenCalledOnce();
    expect(downloader.getSnapshot()).toMatchObject({ status: "ready", tag: update.tag });
    expect(environment.onFailure).toHaveBeenCalledOnce();
    vi.mocked(environment.install).mockResolvedValue(true);
    await downloader.start(update);
    expect(environment.download).toHaveBeenCalledOnce();
    expect(environment.install).toHaveBeenCalledTimes(2);
  });

  it("discards an older APK when another release is selected", async () => {
    const { downloader, environment, apk } = fixture({ isForeground: async () => false });
    await downloader.start(update);
    const newer = { ...update, tag: "android-1.4.1-21" };
    await downloader.start(newer);
    expect(apk.dispose).toHaveBeenCalledOnce();
    expect(environment.download).toHaveBeenCalledTimes(2);
    expect(downloader.getSnapshot()).toEqual({ status: "ready", tag: newer.tag });
  });

  it("downloads again if Android has evicted the cached APK", async () => {
    const { downloader, environment, apk } = fixture({ isForeground: async () => false });
    await downloader.start(update);
    apk.exists = () => false;
    await downloader.start(update);
    expect(environment.download).toHaveBeenCalledTimes(2);
  });
});
