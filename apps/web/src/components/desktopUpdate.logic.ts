import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DESKTOP_RELEASE_TAG_URL = "https://github.com/pingdotgg/t3code/releases/tag";

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** Release notes for an exact downloaded build; nightly suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available" && state.errorContext === "download" && state.canRetry) {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

/** The sidebar stays quiet until a downloaded update can be installed. */
export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  return resolveDesktopUpdateButtonAction(state) === "install";
}

export type DesktopUpdateButtonTone = "cta" | "quiet" | "idle";

/**
 * The background download needs no input, so it stays quiet. Only a state that
 * wants a click — install, or retry a failed download — gets call-to-action colour.
 */
export function resolveDesktopUpdateButtonTone(
  state: DesktopUpdateState | null,
): DesktopUpdateButtonTone {
  if (state && resolveDesktopUpdateButtonAction(state) !== "none") {
    return "cta";
  }
  if (state?.status === "downloading") {
    return "quiet";
  }
  return "idle";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

/** Statuses driven entirely by the updater should not look like clickable actions. */
export function getDesktopUpdateProgressLabel(state: DesktopUpdateState | null): string | null {
  if (state?.status === "checking") {
    return "Checking…";
  }
  if (state?.status === "available" && state.errorContext !== "download") {
    return "Preparing download…";
  }
  if (state?.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` ${Math.floor(state.downloadPercent)}%` : "";
    return `Downloading…${progress}`;
  }
  return null;
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but styal is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but styal is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  if (state.status === "available" || state.status === "downloading") {
    return "This Mac has Apple Silicon, but styal is still running the Intel build under Rosetta. The available update will replace it with the native Apple Silicon build automatically.";
  }
  return "This Mac has Apple Silicon, but styal is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    if (state.errorContext === "download") {
      return `Download failed for ${state.availableVersion ?? "the available update"}. Click to retry.`;
    }
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    if (state.downloadedVersion) {
      return `Update ${state.downloadedVersion} downloaded. Click to restart and install.`;
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}
