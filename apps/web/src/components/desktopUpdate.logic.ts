import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "incognitojam/styal";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_DESKTOP_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
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
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

/** The sidebar stays quiet until an update is found: idle and failed checks show nothing. */
export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  return (
    resolveDesktopUpdateButtonAction(state) !== "none" ||
    state.status === "downloading" ||
    (state.status === "checking" && state.downloadedVersion !== null)
  );
}

export type DesktopUpdateButtonTone = "cta" | "quiet" | "idle";

/** A running download needs no input, so it stays quiet; download and install want a click. */
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

export function getDesktopUpdateSettingsButtonLabel(
  state: DesktopUpdateState | null,
  { offTrack = false }: { readonly offTrack?: boolean } = {},
): string {
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  if (action === "download") {
    return state?.errorContext === "download" ? "Retry Download" : "Download";
  }
  if (action === "install") {
    return state?.errorContext === "install" ? "Retry Install" : "Restart to Install";
  }
  if (state?.status === "checking") return "Checking…";
  // Off its track, "up to date" only means no switch is pending; Review moves it.
  if (state?.status === "up-to-date" && !offTrack) return "Up to Date";
  return "Check for Updates";
}

/** A download or install that failed, or an install that did not take; the next click retries it. */
export function isDesktopUpdateFailed(state: DesktopUpdateState): boolean {
  if (resolveDesktopUpdateButtonAction(state) === "none") return false;
  return (
    state.errorContext === "download" ||
    state.errorContext === "install" ||
    isDesktopUpdateNotApplied(state)
  );
}

function isDesktopUpdateNotApplied(state: DesktopUpdateState): boolean {
  return (
    state.notAppliedVersion !== undefined &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  );
}

function withMessage(text: string, message: string | null): string {
  const detail = message?.trim();
  return detail ? `${text}: ${detail}` : `${text}.`;
}

/** What the Settings version row says about an update; null when there is none to describe. */
export function getDesktopUpdateSettingsDescription(state: DesktopUpdateState): string | null {
  const available = state.availableVersion;
  const downloaded = state.downloadedVersion;
  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download" && state.errorContext === "download") {
    return withMessage(`Could not download version ${available}`, state.message);
  }
  if (action === "install" && state.errorContext === "install") {
    return withMessage(`Could not install version ${downloaded}`, state.message);
  }
  if (action !== "none" && isDesktopUpdateNotApplied(state)) {
    return `Version ${state.notAppliedVersion} did not install.`;
  }
  if (state.status === "downloading") {
    return available ? `Downloading version ${available}.` : "Downloading an update.";
  }
  if (state.status === "checking" && downloaded) {
    return `Version ${downloaded} is ready to install. Checking for a newer one…`;
  }
  if (action === "install" && downloaded) return `Version ${downloaded} is ready to install.`;
  if (action === "download" && available) return `Version ${available} is available.`;
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
  return "This Mac has Apple Silicon, but styal is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

/** The sidebar button's tooltip and release-notes heading: a summary line, then any updater message. */
export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  const detail = state.message?.trim() ? `\n${state.message.trim()}` : "";
  if (state.status === "checking" && state.downloadedVersion !== null) {
    return `Version ${state.downloadedVersion} is ready to install. Checking for a newer one…`;
  }
  if (
    (state.status === "available" || state.status === "error") &&
    state.errorContext === "download" &&
    state.availableVersion
  ) {
    return `Could not download version ${state.availableVersion}. Click to retry.${detail}`;
  }
  if (
    (state.status === "downloaded" || state.status === "error") &&
    state.errorContext === "install" &&
    state.downloadedVersion
  ) {
    return `Could not install version ${state.downloadedVersion}. Click to retry.${detail}`;
  }
  if (
    (state.status === "available" || state.status === "downloaded") &&
    isDesktopUpdateNotApplied(state)
  ) {
    return `Version ${state.notAppliedVersion} did not install. Click to retry.`;
  }
  if (state.status === "available") {
    return state.availableVersion
      ? `Version ${state.availableVersion} is available. Click to download.`
      : "An update is available. Click to download.";
  }
  if (state.status === "downloading") {
    const version = state.availableVersion ? `version ${state.availableVersion}` : "an update";
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading ${version}${progress}`;
  }
  const ready = state.downloadedVersion ?? state.availableVersion;
  const readyLine = `${ready ? `Version ${ready}` : "An update"} is ready to install. Click to restart.`;
  if (state.status === "downloaded") return readyLine;
  if (state.status === "error") {
    return state.downloadedVersion ? readyLine : (state.message ?? "Update failed");
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

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "Automatic updates are not available in this build.";
}
