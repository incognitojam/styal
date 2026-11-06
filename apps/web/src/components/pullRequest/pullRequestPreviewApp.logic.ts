import {
  DESKTOP_PREVIEW_APP_REPOSITORY,
  type DesktopPreviewAppBuild,
  type DesktopPreviewAppState,
  type PullRequestDetail,
} from "@t3tools/contracts";

const PREVIEW_LABEL = "preview:mac";
// Job names in .github/workflows/desktop-macos-preview.yml.
const PREVIEW_BUILD_CHECKS = new Set([
  "Build macOS Apple Silicon preview",
  "Publish anonymous download",
]);

export function pullRequestCanHavePreviewApp(
  detail: Pick<PullRequestDetail, "provider" | "labels">,
  repository: string,
): boolean {
  return (
    detail.provider === "github" &&
    repository.toLowerCase() === DESKTOP_PREVIEW_APP_REPOSITORY &&
    detail.labels.some((label) => label.name === PREVIEW_LABEL)
  );
}

export function previewBuildIsRunning(detail: Pick<PullRequestDetail, "checks">): boolean {
  return detail.checks.some(
    (check) => PREVIEW_BUILD_CHECKS.has(check.name) && check.status === "pending",
  );
}

export type PreviewAppControlView =
  | { readonly kind: "hidden" }
  | { readonly kind: "busy"; readonly label: string; readonly canCancel: boolean }
  | { readonly kind: "building" }
  | { readonly kind: "lookup-failed" }
  | {
      readonly kind: "install";
      readonly label: string;
      readonly build: DesktopPreviewAppBuild;
      readonly replaces: NonNullable<DesktopPreviewAppState["installed"]> | null;
      readonly newerBuildRunning: boolean;
    }
  | { readonly kind: "open"; readonly canOpen: boolean };

/** What the pull request panel offers. A build older than the installed one is never offered. */
export function previewAppControlView(input: {
  readonly pullRequestNumber: number;
  readonly state: DesktopPreviewAppState | null;
  readonly build: DesktopPreviewAppBuild | null;
  readonly buildRunning: boolean;
  readonly lookupFailed: boolean;
}): PreviewAppControlView {
  const { pullRequestNumber, state, build, buildRunning, lookupFailed } = input;
  if (state === null || !state.supported) return { kind: "hidden" };
  const { activity, installed } = state;
  const installedHere = installed?.pullRequestNumber === pullRequestNumber ? installed : null;

  if (activity.status === "installing") {
    if (activity.pullRequestNumber !== pullRequestNumber) {
      return {
        kind: "busy",
        label: `Installing #${activity.pullRequestNumber}`,
        canCancel: false,
      };
    }
    switch (activity.phase) {
      case "confirming":
        return { kind: "busy", label: "Waiting for confirmation…", canCancel: false };
      case "downloading":
        return { kind: "busy", label: `Downloading ${activity.progress ?? 0}%`, canCancel: true };
      case "copying":
        return { kind: "busy", label: "Copying…", canCancel: true };
      case "quitting":
        return { kind: "busy", label: "Quitting preview…", canCancel: true };
      case "opening":
        return { kind: "busy", label: "Opening…", canCancel: false };
    }
  }
  if (activity.status === "removing") {
    return { kind: "busy", label: "Removing…", canCancel: false };
  }
  if (activity.status === "resetting") {
    return { kind: "busy", label: "Resetting…", canCancel: false };
  }

  if (build !== null && state.canInstall) {
    if (installedHere === null || build.runNumber > installedHere.runNumber) {
      return {
        kind: "install",
        label: state.opensAfterInstall ? "Install and open" : "Install",
        build,
        replaces: installed,
        newerBuildRunning: buildRunning,
      };
    }
  }
  // A preview running from the install location has nothing to offer about its own copy.
  if (installedHere !== null && (state.canOpen || state.canRemove || state.canReset)) {
    return { kind: "open", canOpen: state.canOpen };
  }
  if (buildRunning) return { kind: "building" };
  return lookupFailed ? { kind: "lookup-failed" } : { kind: "hidden" };
}
