import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateSettingsButtonLabel,
  getDesktopUpdateSettingsDescription,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
  resolveDesktopUpdateButtonTone,
  shouldShowDesktopUpdateButton,
  getArm64IntelBuildWarningDescription,
  isDesktopUpdateButtonDisabled,
  isDesktopUpdateFailed,
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

  it("waits for Download when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateSettingsButtonLabel(state)).toBe("Download");
    expect(getDesktopUpdateSettingsDescription(state)).toBe("Version 1.1.0 is available.");
    expect(isDesktopUpdateFailed(state)).toBe(false);
  });

  it("offers a failed download for retry in the sidebar and Settings", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateSettingsButtonLabel(state)).toBe("Retry Download");
    expect(getDesktopUpdateButtonTooltip(state)).toBe(
      "Download failed for 1.1.0. Click to retry.\nnetwork timeout",
    );
    expect(getDesktopUpdateSettingsDescription(state)).toBe(
      "Could not download version 1.1.0: network timeout",
    );
    expect(isDesktopUpdateFailed(state)).toBe(true);
  });

  it.each(["error", "downloaded"] as const)(
    "keeps install action available after an install error (%s)",
    (status) => {
      const state: DesktopUpdateState = {
        ...baseState,
        status,
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: "shutdown timeout",
        errorContext: "install",
        canRetry: true,
      };
      expect(shouldShowDesktopUpdateButton(state)).toBe(true);
      expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
      expect(getDesktopUpdateSettingsButtonLabel(state)).toBe("Retry Install");
      expect(getDesktopUpdateButtonTooltip(state)).toBe(
        "Install failed for 1.1.0. Click to retry.\nshutdown timeout",
      );
      expect(getDesktopUpdateSettingsDescription(state)).toBe(
        "Could not install version 1.1.0: shutdown timeout",
      );
      expect(isDesktopUpdateFailed(state)).toBe(true);
    },
  );

  it("names both versions when a newer release is offered beside a downloaded one", () => {
    const base: DesktopUpdateState = {
      ...baseState,
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(getDesktopUpdateSettingsDescription({ ...base, status: "downloaded" })).toBe(
      "Version 1.1.0 is ready to install. Version 1.2.0 is also available.",
    );
    expect(getDesktopUpdateSettingsDescription({ ...base, status: "available" })).toBe(
      "Version 1.2.0 is available. Version 1.1.0 is ready to install.",
    );
    expect(
      getDesktopUpdateSettingsDescription({
        ...base,
        availableVersion: "1.1.0",
        status: "downloaded",
      }),
    ).toBe("Version 1.1.0 is ready to install.");
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
    expect(getDesktopUpdateSettingsButtonLabel(state)).toBe("Restart to Install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to restart and install");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
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
    expect(getDesktopUpdateSettingsDescription(state)).toBe(
      "Version 1.1.0 is ready to install. Checking for a newer one…",
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
    expect(getDesktopUpdateSettingsDescription(state)).toBeNull();
  });

  it("describes a running download by version in the sidebar and Settings", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateSettingsDescription(state)).toBe("Downloading version 1.1.0.");
    expect(getDesktopUpdateButtonTooltip(state)).toBe("Downloading update 1.1.0 (42%)");
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

  it("calls for action when an update is available to download", () => {
    expect(
      resolveDesktopUpdateButtonTone({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
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

describe("getDesktopUpdateSettingsButtonLabel", () => {
  it("names updater status and the check action", () => {
    expect(getDesktopUpdateSettingsButtonLabel({ ...baseState, status: "checking" })).toBe(
      "Checking…",
    );
    expect(getDesktopUpdateSettingsButtonLabel({ ...baseState, status: "up-to-date" })).toBe(
      "Up to Date",
    );
    expect(
      getDesktopUpdateSettingsButtonLabel(
        { ...baseState, status: "up-to-date" },
        { offTrack: true },
      ),
    ).toBe("Check for Updates");
    expect(getDesktopUpdateSettingsButtonLabel(baseState)).toBe("Check for Updates");
    expect(getDesktopUpdateSettingsButtonLabel(null)).toBe("Check for Updates");
  });

  it("offers Restart to Install once the update is downloaded", () => {
    expect(
      getDesktopUpdateSettingsButtonLabel({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe("Restart to Install");
  });
});

describe("desktop update UI helpers", () => {
  it.each(["owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "falls back to styal for an invalid configured repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/incognitojam/styal/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/incognitojam/styal/releases/tag/v1.2.3",
      );
    },
  );

  it("asks to download an available native build", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain(
      "Download the available update to switch to the native Apple Silicon build",
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
