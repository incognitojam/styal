import { useSyncExternalStore } from "react";

import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import type { NativeAppUpdate } from "./native-app-updates";

type CachedApk = {
  readonly uri: string;
  readonly exists: () => boolean;
  readonly dispose: () => void;
};
type DownloadState =
  | { readonly status: "idle" }
  | { readonly status: "downloading"; readonly tag: string; readonly percent: number }
  | { readonly status: "ready"; readonly tag: string; readonly message?: string }
  | { readonly status: "installing"; readonly tag: string }
  | { readonly status: "error"; readonly tag: string };

export interface NativeAppUpdateDownloadEnvironment {
  readonly download: (
    update: NativeAppUpdate,
    signal: AbortSignal,
    onProgress: (percent: number) => void,
  ) => Promise<CachedApk>;
  /** False means the user returned from Settings without allowing installs. */
  readonly install: (uri: string) => Promise<boolean>;
  readonly isForeground: () => Promise<boolean>;
  readonly onFailure: (message: string) => void;
}

/** A single download survives navigating away from About; canceled work cannot open an installer. */
export function createNativeAppUpdateDownloader(environment: NativeAppUpdateDownloadEnvironment) {
  let state: DownloadState = { status: "idle" };
  const listeners = new Set<() => void>();
  let activeDownload: AbortController | undefined;
  let cached: { readonly tag: string; readonly apk: CachedApk } | undefined;

  function setState(next: DownloadState) {
    state = next;
    for (const listener of listeners) listener();
  }

  async function install() {
    if (!cached || state.status === "installing" || activeDownload) return;
    const { tag, apk } = cached;
    setState({ status: "installing", tag });
    try {
      const allowed = await environment.install(apk.uri);
      setState({
        status: "ready",
        tag,
        ...(allowed ? {} : { message: "Allow installs from styal to continue" }),
      });
    } catch {
      const message = "Could not open the installer. Tap to try again.";
      setState({ status: "ready", tag, message });
      environment.onFailure(message);
    }
  }

  async function start(update: NativeAppUpdate) {
    if (activeDownload || state.status === "installing") return;
    if (cached?.tag === update.tag && cached.apk.exists()) {
      await install();
      return;
    }
    cached?.apk.dispose();
    cached = undefined;
    const controller = new AbortController();
    activeDownload = controller;
    setState({ status: "downloading", tag: update.tag, percent: 0 });
    try {
      const apk = await environment.download(update, controller.signal, (percent) => {
        if (controller.signal.aborted) return;
        const rounded = Math.max(0, Math.min(100, Math.floor(percent)));
        // Publish only whole percentages, keeping the About screen quiet between changes.
        if (state.status === "downloading" && state.percent !== rounded) {
          setState({ status: "downloading", tag: update.tag, percent: rounded });
        }
      });
      if (controller.signal.aborted) {
        apk.dispose();
        return;
      }
      cached = { tag: update.tag, apk };
      setState({ status: "ready", tag: update.tag });
    } catch {
      if (!controller.signal.aborted) {
        setState({ status: "error", tag: update.tag });
        environment.onFailure(
          "Could not download the update. Check your connection and try again.",
        );
      }
    } finally {
      activeDownload = undefined;
      if (controller.signal.aborted) setState({ status: "idle" });
    }
    // Downloads can finish in the background. Leave the install action in About
    // rather than opening another activity over whatever the user is doing.
    if (
      cached?.tag === update.tag &&
      !controller.signal.aborted &&
      (await environment.isForeground())
    ) {
      await install();
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    cancel: () => activeDownload?.abort(),
  };
}

/** Reuse a complete APK after an installer dismissal or app restart; discard partial and older APKs. */
async function downloadApk(
  update: NativeAppUpdate,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<CachedApk> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, "android-updates");
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, `${update.tag}.apk`);
  for (const entry of directory.list()) {
    if (entry.uri !== file.uri) entry.delete();
  }
  const dispose = () => {
    if (file.exists) file.delete();
  };
  try {
    if (signal.aborted) throw new Error("Download canceled.");
    if (!file.exists || file.size !== update.apkSizeBytes) {
      dispose();
      await File.downloadFileAsync(update.apkUrl, file, {
        signal,
        onProgress: ({ bytesWritten }) => onProgress((bytesWritten / update.apkSizeBytes) * 100),
      });
    }
    if (signal.aborted || file.size !== update.apkSizeBytes) {
      throw new Error("The APK download is incomplete.");
    }
    return { uri: file.uri, exists: () => file.exists, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

async function installApk(uri: string): Promise<boolean> {
  const { requireNativeModule } = await import("expo");
  const controls = requireNativeModule<{
    requestPackageInstallPermission(): Promise<boolean>;
    openFile(uri: string, mimeType: string): Promise<void>;
  }>("T3NativeControls");
  // Keep a pending OTA restart from interrupting Android Settings or the installer.
  const endHandoff = beginForegroundHandoff();
  try {
    if (!(await controls.requestPackageInstallPermission())) return false;
    await controls.openFile(uri, "application/vnd.android.package-archive");
    return true;
  } finally {
    endHandoff();
  }
}

export const nativeAppUpdateDownloader = createNativeAppUpdateDownloader({
  download: downloadApk,
  install: installApk,
  isForeground: async () => (await import("react-native")).AppState.currentState === "active",
  onFailure: (message) => {
    void import("react-native").then(({ Alert }) => Alert.alert("Update failed", message));
  },
});

export function useNativeAppUpdateDownload() {
  return useSyncExternalStore(
    nativeAppUpdateDownloader.subscribe,
    nativeAppUpdateDownloader.getSnapshot,
  );
}
