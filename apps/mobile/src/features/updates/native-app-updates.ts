import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useSyncExternalStore } from "react";

import { isAppUpdateCheckAvailable, shouldRecheckAppUpdateOnForeground } from "./app-updates";

/**
 * Android installs come from GitHub releases rather than a store, and an
 * over-the-air update only reaches binaries with the same runtime version
 * (native fingerprint). When the newest release carries a different runtime,
 * this install has stopped receiving updates until the user installs that APK.
 *
 * .github/scripts/publish-android-release.sh publishes the release tags and
 * the manifest asset read here.
 */
const RELEASE_REPOSITORY = "incognitojam/styal";
const RELEASE_TAGS_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/git/matching-refs/tags/android-`;
const RELEASE_DOWNLOAD_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/download`;
export const ANDROID_UPDATE_MANIFEST_ASSET = "android-update.json";

const RELEASE_TAG_PATTERN = /^refs\/tags\/(android-\d+(?:\.\d+)*-(\d+))$/;
const REQUEST_TIMEOUT_MS = 15_000;

export interface NativeAppUpdate {
  readonly tag: string;
  readonly version: string;
  readonly apkUrl: string;
  readonly apkSizeBytes: number;
}

/** Picks the release with the highest versionCode from GitHub's matching-refs response. */
export function newestAndroidReleaseTag(refs: unknown): string | undefined {
  if (!Array.isArray(refs)) return undefined;
  let newest: { readonly tag: string; readonly versionCode: number } | undefined;
  for (const entry of refs) {
    const ref: unknown = entry?.ref;
    if (typeof ref !== "string") continue;
    const match = RELEASE_TAG_PATTERN.exec(ref);
    if (!match) continue;
    const versionCode = Number(match[2]);
    if (!newest || versionCode > newest.versionCode) {
      newest = { tag: match[1]!, versionCode };
    }
  }
  return newest?.tag;
}

/**
 * Returns the release when it needs a new installation, meaning its runtime
 * version differs from the installed binary's. A malformed manifest yields
 * nothing rather than a prompt the user cannot act on.
 */
export function resolveNativeAppUpdate(
  tag: string,
  manifest: unknown,
  installedRuntimeVersion: string,
): NativeAppUpdate | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const { apk, apkSizeBytes, runtimeVersion, version } = manifest as Record<string, unknown>;
  if (
    typeof apk !== "string" ||
    !/^[\w.-]+\.apk$/.test(apk) ||
    typeof apkSizeBytes !== "number" ||
    typeof runtimeVersion !== "string" ||
    runtimeVersion.length === 0 ||
    typeof version !== "string"
  ) {
    return undefined;
  }
  if (runtimeVersion === installedRuntimeVersion) return undefined;
  return { tag, version, apkUrl: `${RELEASE_DOWNLOAD_URL}/${tag}/${apk}`, apkSizeBytes };
}

/** Binary megabytes, matching the size Chrome shows when the download starts. */
export function formatApkSize(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
}

async function fetchJson(fetcher: typeof fetch, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    // A newest tag without a manifest predates manifests; nothing to offer.
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GET ${url} returned ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function findNativeAppUpdate(
  fetcher: typeof fetch,
  installedRuntimeVersion: string,
): Promise<NativeAppUpdate | undefined> {
  const tag = newestAndroidReleaseTag(await fetchJson(fetcher, RELEASE_TAGS_URL));
  if (!tag) return undefined;
  const manifest = await fetchJson(
    fetcher,
    `${RELEASE_DOWNLOAD_URL}/${tag}/${ANDROID_UPDATE_MANIFEST_ASSET}`,
  );
  return resolveNativeAppUpdate(tag, manifest, installedRuntimeVersion);
}

export interface NativeAppUpdateEnvironment {
  readonly isSupported: () => boolean;
  readonly installedRuntimeVersion: () => string | null;
  readonly fetch: typeof fetch;
  /** Android drops an alert raised while the app is backgrounded. */
  readonly isForeground: () => Promise<boolean>;
  /** The release tag the user was last prompted about, so each release prompts once. */
  readonly loadPromptedTag: () => Promise<string | undefined>;
  readonly savePromptedTag: (tag: string) => Promise<void>;
  /** Resolves `true` when the user chose to download now. */
  readonly confirmDownload: (update: NativeAppUpdate) => Promise<boolean>;
  readonly openDownload: (update: NativeAppUpdate) => Promise<void>;
}

/** Holds the update found by the latest check for the About screen. */
export interface NativeAppUpdateStore {
  current: NativeAppUpdate | undefined;
  readonly listeners: Set<() => void>;
}

export function createNativeAppUpdateStore(): NativeAppUpdateStore {
  return { current: undefined, listeners: new Set() };
}

const nativeAppUpdateStore = createNativeAppUpdateStore();
let nativeAppUpdateCheckInFlight: Promise<void> | undefined;

function setAvailableNativeAppUpdate(
  store: NativeAppUpdateStore,
  update: NativeAppUpdate | undefined,
): void {
  if (store.current?.tag === update?.tag && store.current?.apkUrl === update?.apkUrl) return;
  store.current = update;
  for (const listener of Array.from(store.listeners)) listener();
}

/**
 * Checks GitHub for a release this install cannot reach over the air and asks
 * once per release whether to download it. Failures leave the last result in
 * place: the check is advisory and runs again on later foregrounds.
 */
export async function runNativeAppUpdateCheck(
  environment: NativeAppUpdateEnvironment = defaultNativeAppUpdateEnvironment,
  store: NativeAppUpdateStore = nativeAppUpdateStore,
): Promise<void> {
  if (!environment.isSupported()) return;
  const installedRuntimeVersion = environment.installedRuntimeVersion();
  if (!installedRuntimeVersion) return;

  let update: NativeAppUpdate | undefined;
  try {
    update = await findNativeAppUpdate(environment.fetch, installedRuntimeVersion);
  } catch (error) {
    console.warn("Could not check for a new Android release.", error);
    return;
  }
  setAvailableNativeAppUpdate(store, update);
  if (!update) return;

  const promptedTag = await environment.loadPromptedTag().catch(() => undefined);
  // Leaving the tag unrecorded lets the next foreground check ask instead.
  if (promptedTag === update.tag || !(await environment.isForeground())) return;
  // Record the prompt before showing it, so a failed save cannot turn every
  // launch into another prompt. The About screen keeps the download reachable.
  await environment.savePromptedTag(update.tag).catch((error: unknown) => {
    console.warn("Could not record the Android release prompt.", error);
  });
  if (await environment.confirmDownload(update)) {
    await environment.openDownload(update);
  }
}

function runSharedNativeAppUpdateCheck(): Promise<void> {
  nativeAppUpdateCheckInFlight ??= runNativeAppUpdateCheck().finally(() => {
    nativeAppUpdateCheckInFlight = undefined;
  });
  return nativeAppUpdateCheckInFlight;
}

let nativeAppUpdateChecksStarted = false;

/** Checks at launch and again when the app returns after a long background. */
export function startNativeAppUpdateChecks(): void {
  if (nativeAppUpdateChecksStarted || !defaultNativeAppUpdateEnvironment.isSupported()) return;
  nativeAppUpdateChecksStarted = true;
  void runSharedNativeAppUpdateCheck();
  void import("react-native").then(({ AppState }) => {
    let backgroundedAtMs: number | null = null;
    AppState.addEventListener("change", (state) => {
      if (state === "background") {
        backgroundedAtMs = Date.now();
        return;
      }
      if (state !== "active") return;
      const shouldCheck = shouldRecheckAppUpdateOnForeground(backgroundedAtMs, Date.now(), false);
      backgroundedAtMs = null;
      if (shouldCheck) void runSharedNativeAppUpdateCheck();
    });
  });
}

export function useAvailableNativeAppUpdate(): NativeAppUpdate | undefined {
  return useSyncExternalStore(
    (listener) => {
      nativeAppUpdateStore.listeners.add(listener);
      return () => nativeAppUpdateStore.listeners.delete(listener);
    },
    () => nativeAppUpdateStore.current,
  );
}

export async function openNativeAppUpdateDownload(update: NativeAppUpdate): Promise<void> {
  const { tryOpenExternalUrl } = await import("../../lib/openExternalUrl");
  await tryOpenExternalUrl(update.apkUrl, "app-update");
}

async function defaultConfirmDownload(update: NativeAppUpdate): Promise<boolean> {
  const { Alert } = await import("react-native");
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      "Update available",
      `styal ${update.version} is ready to download (${formatApkSize(update.apkSizeBytes)}).`,
      [
        { onPress: () => resolve(false), style: "cancel", text: "Later" },
        { onPress: () => resolve(true), text: "Download" },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

const defaultNativeAppUpdateEnvironment: NativeAppUpdateEnvironment = {
  // Only production APKs come from these releases; preview and development
  // builds use other application IDs and update channels.
  isSupported: () =>
    Constants.platform?.android !== undefined &&
    isAppUpdateCheckAvailable() &&
    (Constants.expoConfig?.extra?.appVariant ?? "production") === "production",
  installedRuntimeVersion: () => Updates.runtimeVersion,
  fetch: (input, init) => fetch(input, init),
  isForeground: async () => {
    const { AppState } = await import("react-native");
    return AppState.currentState === "active";
  },
  loadPromptedTag: async () => {
    const { loadPreferences } = await import("../../persistence/imperative");
    return (await loadPreferences()).nativeUpdatePromptedTag;
  },
  savePromptedTag: async (tag) => {
    const { savePreferencesPatch } = await import("../../persistence/imperative");
    await savePreferencesPatch({ nativeUpdatePromptedTag: tag });
  },
  confirmDownload: defaultConfirmDownload,
  openDownload: openNativeAppUpdateDownload,
};
