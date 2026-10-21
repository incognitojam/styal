import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateProgressLabel,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
  resolveDesktopUpdateButtonTone,
  shouldShowDesktopUpdateButton,
  getArm64IntelBuildWarningDescription,
  isDesktopUpdateButtonDisabled,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it.each(["idle", "checking", "disabled"] as const)(
    "hides the sidebar icon while %s",
    (status) => {
      expect(shouldShowDesktopUpdateButton({ ...baseState, status })).toBe(false);
    },
  );

  it("presents a newly available update as automatic work", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
    expect(getDesktopUpdateProgressLabel(state)).toBe("Preparing download…");
  });

  it("keeps download retry in Settings without showing a sidebar icon", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateProgressLabel(state)).toBeNull();
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after a background updater error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "background updater error",
      errorContext: null,
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to restart and install");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("keeps the downloaded update visible while checking without offering install", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toBe(
      "Update 1.1.0 downloaded. Checking for newer updates…",
    );
    expect(canCheckForUpdate(state)).toBe(false);
    expect(shouldShowDesktopUpdateButton({ ...state, enabled: false })).toBe(false);
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("hides the sidebar button while retaining disabled download progress in Settings", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });
});

describe("resolveDesktopUpdateButtonTone", () => {
  it("stays quiet while the update downloads in the background", () => {
    expect(
      resolveDesktopUpdateButtonTone({
        ...baseState,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 42.5,
      }),
    ).toBe("quiet");
  });

  it("calls for action once the update is downloaded", () => {
    expect(
      resolveDesktopUpdateButtonTone({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe("cta");
  });

  it("calls for action when a failed download can be retried", () => {
    expect(
      resolveDesktopUpdateButtonTone({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "network unavailable",
        errorContext: "download",
        canRetry: true,
      }),
    ).toBe("cta");
  });

  it("stays idle when there is no update to act on", () => {
    expect(resolveDesktopUpdateButtonTone(baseState)).toBe("idle");
    expect(resolveDesktopUpdateButtonTone({ ...baseState, status: "checking" })).toBe("idle");
    expect(resolveDesktopUpdateButtonTone(null)).toBe("idle");
  });
});

describe("getDesktopUpdateProgressLabel", () => {
  it("presents automatic updater work as status text", () => {
    expect(getDesktopUpdateProgressLabel({ ...baseState, status: "checking" })).toBe("Checking…");
    expect(
      getDesktopUpdateProgressLabel({
        ...baseState,
        status: "downloading",
        downloadPercent: 42.5,
      }),
    ).toBe("Downloading… 42%");
  });

  it("leaves user actions to the button control", () => {
    expect(
      getDesktopUpdateProgressLabel({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        errorContext: "download",
        canRetry: true,
      }),
    ).toBeNull();
    expect(
      getDesktopUpdateProgressLabel({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
      }),
    ).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it.each([
    "owner/repo/extra",
    "owner#notes/repo",
    "owner/repo#notes",
    "owner?tab=notes/repo",
    "owner/repo?tab=notes",
  ])("falls back to styal for an invalid configured repository: %s", (repository) => {
    expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
      "https://github.com/incognitojam/styal/releases",
    );
    expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
      "https://github.com/incognitojam/styal/releases/tag/v1.2.3",
    );
  });

  it("explains that an available native build downloads automatically", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain(
      "replace it with the native Apple Silicon build automatically",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});
