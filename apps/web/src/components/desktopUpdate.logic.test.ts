import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateProgressLabel,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  resolveDesktopUpdateButtonTone,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
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

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
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

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("builds the stable release URL for a downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
    );
  });

  it("builds the nightly release URL without dropping its version suffix", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30-nightly.20260728.931",
    );
  });

  it("omits the release URL when the updater does not report a version", () => {
    expect(getDesktopUpdateReleaseUrl(null)).toBeNull();
    expect(getDesktopUpdateReleaseUrl("  ")).toBeNull();
  });

  it("builds the release history URL", () => {
    expect(getDesktopUpdateReleaseHistoryUrl()).toBe(
      "https://github.com/pingdotgg/t3code/releases",
    );
  });

  it("toasts only for actionable updater errors", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: null },
      }),
    ).toBe(false);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
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
  it("returns false for null state", () => {
    expect(canCheckForUpdate(null)).toBe(false);
  });

  it("returns false when updates are disabled", () => {
    expect(canCheckForUpdate({ ...baseState, enabled: false, status: "disabled" })).toBe(false);
  });

  it("returns false while checking", () => {
    expect(canCheckForUpdate({ ...baseState, status: "checking" })).toBe(false);
  });

  it("returns false while downloading", () => {
    expect(canCheckForUpdate({ ...baseState, status: "downloading", downloadPercent: 50 })).toBe(
      false,
    );
  });

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

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("returns 'Up to date' for non-actionable states", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("Up to date");
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "up-to-date" })).toBe(
      "Up to date",
    );
  });
});
