import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DownloadOptions } from "expo-file-system";

const mocks = vi.hoisted(() => ({
  files: new Map<string, number>(),
  download: vi.fn(),
  permission: vi.fn(),
  open: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class File {
    static downloadFileAsync = mocks.download;
    readonly uri: string;
    constructor(directory: { uri: string } | string, name?: string) {
      this.uri = typeof directory === "string" ? directory : `${directory.uri}/${name}`;
    }
    get exists() {
      return mocks.files.has(this.uri);
    }
    get size() {
      return mocks.files.get(this.uri) ?? 0;
    }
    delete() {
      mocks.files.delete(this.uri);
    }
  }
  class Directory {
    readonly uri: string;
    constructor(root: string, name: string) {
      this.uri = `${root}/${name}`;
    }
    create() {}
    list() {
      return [...mocks.files.keys()].map((uri) => new File(uri));
    }
  }
  return { File, Directory, Paths: { cache: "file:///cache" } };
});
vi.mock("expo", () => ({
  requireNativeModule: () => ({
    requestPackageInstallPermission: mocks.permission,
    openFile: mocks.open,
  }),
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "active" },
  Alert: { alert: mocks.alert },
}));

const update = {
  tag: "android-1.4.0-20",
  version: "1.4.0",
  apkUrl: "https://example.com/styal.apk",
  apkSizeBytes: 100,
};
const apkUri = "file:///cache/android-updates/android-1.4.0-20.apk";

beforeEach(() => {
  vi.resetModules();
  mocks.files.clear();
  mocks.download.mockReset();
  mocks.download.mockImplementation(
    async (_url: string, file: { uri: string }, options: DownloadOptions) => {
      mocks.files.set(file.uri, 100);
      options.onProgress?.({ bytesWritten: 100, totalBytes: 100 });
      return file;
    },
  );
  mocks.permission.mockReset().mockResolvedValue(true);
  mocks.open.mockReset().mockResolvedValue(undefined);
  mocks.alert.mockClear();
});
afterEach(async () => {
  const { isForegroundHandoffActive } = await import("../../lib/foreground-handoff");
  expect(isForegroundHandoffActive()).toBe(false);
});

describe("APK cache and Android handoff", () => {
  it("downloads to the private cache and grants access through the native viewer with APK MIME type", async () => {
    const { nativeAppUpdateDownloader } = await import("./native-app-update-download");
    const { isForegroundHandoffActive } = await import("../../lib/foreground-handoff");
    mocks.permission.mockImplementation(async () => {
      expect(isForegroundHandoffActive()).toBe(true);
      return true;
    });
    mocks.open.mockImplementation(async () => expect(isForegroundHandoffActive()).toBe(true));
    await nativeAppUpdateDownloader.start(update);
    expect(mocks.files.get(apkUri)).toBe(100);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(
      apkUri,
      "application/vnd.android.package-archive",
    );
  });

  it("rejects and removes an incomplete APK before requesting permission or opening an installer", async () => {
    mocks.download.mockImplementation(async (_url: string, file: { uri: string }) => {
      mocks.files.set(file.uri, 99);
      return file;
    });
    const { nativeAppUpdateDownloader } = await import("./native-app-update-download");
    await nativeAppUpdateDownloader.start(update);
    expect(mocks.files.has(apkUri)).toBe(false);
    expect(mocks.permission).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(nativeAppUpdateDownloader.getSnapshot().status).toBe("error");
  });

  it("removes a failed request's partial file", async () => {
    mocks.download.mockImplementation(async (_url: string, file: { uri: string }) => {
      mocks.files.set(file.uri, 50);
      throw new Error("Connection lost");
    });
    const { nativeAppUpdateDownloader } = await import("./native-app-update-download");
    await nativeAppUpdateDownloader.start(update);
    expect(mocks.files.has(apkUri)).toBe(false);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("reuses a complete APK across app restarts and removes older releases", async () => {
    mocks.files.set(apkUri, 100);
    mocks.files.set("file:///cache/android-updates/android-1.3.0-19.apk", 100);
    const { nativeAppUpdateDownloader } = await import("./native-app-update-download");
    await nativeAppUpdateDownloader.start(update);
    expect([...mocks.files.keys()]).toEqual([apkUri]);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it("replaces a partial file left by a terminated process", async () => {
    mocks.files.set(apkUri, 50);
    mocks.download.mockImplementation(async (_url: string, file: { uri: string }) => {
      expect(mocks.files.has(file.uri)).toBe(false);
      mocks.files.set(file.uri, 100);
      return file;
    });
    const { nativeAppUpdateDownloader } = await import("./native-app-update-download");
    await nativeAppUpdateDownloader.start(update);
    expect(mocks.files.get(apkUri)).toBe(100);
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it("does not open the installer when source permission is refused", async () => {
    mocks.permission.mockResolvedValue(false);
    const { nativeAppUpdateDownloader } = await import("./native-app-update-download");
    await nativeAppUpdateDownloader.start(update);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.files.has(apkUri)).toBe(true);
    expect(nativeAppUpdateDownloader.getSnapshot()).toMatchObject({
      status: "ready",
      message: "Allow installs from styal to continue",
    });
  });
});
