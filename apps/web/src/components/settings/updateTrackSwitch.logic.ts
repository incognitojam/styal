import type { DesktopBridge, DesktopUpdateChannel, DesktopUpdateState } from "@t3tools/contracts";
import { acceptsTrackSwitchRelease } from "@t3tools/shared/cliRelease";

type TrackSwitchBridge = Pick<DesktopBridge, "setUpdateChannel">;
type LocalDownloadBridge = Pick<
  DesktopBridge,
  "getUpdateState" | "onUpdateState" | "downloadUpdate"
>;

const downloadEnded = (state: DesktopUpdateState) =>
  state.status === "downloaded" ||
  state.status === "up-to-date" ||
  state.status === "error" ||
  state.errorContext === "download";

/** Waits for the download this app starts by itself once a check finds a build. Starts it only if
 * that did not happen. False once it failed or no longer runs. */
export async function finishLocalDownload(
  bridge: LocalDownloadBridge,
  reportError: (title: string, description: string) => void,
): Promise<boolean> {
  let stop: () => void = () => undefined;
  const settled = new Promise<DesktopUpdateState>((resolve) => {
    stop = bridge.onUpdateState((state) => {
      if (downloadEnded(state)) resolve(state);
    });
  });
  try {
    let state = await bridge.getUpdateState();
    if (state.status === "available" && state.errorContext === null) {
      state = (await bridge.downloadUpdate()).state;
    }
    if (!downloadEnded(state)) state = await settled;
    if (state.status === "downloaded") return true;
    reportError(
      "Could not download update",
      state.message ?? "The download did not finish. Try again in a few minutes.",
    );
    return false;
  } catch (error) {
    reportError(
      "Could not download update",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  } finally {
    stop();
  }
}

/** Saves the track, then, when this app must reinstall, finds a build the database check covers.
 * The saved track is the user's intent and stays even when no such build is ready yet: a track
 * saved toward Stable never offers an older build outside a guarded switch, and "Switch them"
 * retries. Saving when nothing reinstalls lets picking the old track undo a partial switch. */
export async function prepareLocalTrackSwitch(
  bridge: TrackSwitchBridge,
  input: {
    readonly channel: DesktopUpdateChannel;
    readonly version: string;
    readonly reinstall: boolean;
  },
): Promise<
  | { readonly ok: true; readonly local: DesktopUpdateState | null }
  | { readonly ok: false; readonly message: string }
> {
  let local: DesktopUpdateState;
  try {
    // A build on another track re-checks the feed, older releases allowed down to the checked one.
    local = await bridge.setUpdateChannel(
      input.channel,
      input.reinstall ? input.version : undefined,
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The update track did not change.",
    };
  }
  if (!input.reinstall) return { ok: true, local: null };
  const found = local.downloadedVersion ?? local.availableVersion;
  // This app downloads a found build by itself, so the check can return with that under way.
  if (
    (local.status === "available" ||
      local.status === "downloading" ||
      local.status === "downloaded") &&
    found !== null &&
    acceptsTrackSwitchRelease(found, input.channel, input.version)
  ) {
    return { ok: true, local };
  }
  return {
    ok: false,
    message:
      found !== null
        ? `This app found ${found}, which is older than ${input.version}. Try again in a few minutes.`
        : (local.message ?? `This app found no build of ${input.version} to install.`),
  };
}

/**
 * Whether this app stays put while connected machines move: its updater is off, as for a .deb
 * install or without a feed. Off only because a policy rules out its nightly channel, it moves.
 */
export function localUpdaterStaysPut(
  state: Pick<DesktopUpdateState, "enabled" | "channelBlockedByPolicy"> | null | undefined,
  target: DesktopUpdateChannel,
): boolean {
  return (
    state?.enabled === false && !(target === "latest" && state.channelBlockedByPolicy === true)
  );
}
