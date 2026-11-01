import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { acceptsTrackSwitchRelease, desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { useEffect, useState } from "react";
import { AsyncResult } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { npmReleaseAtom, npmReleaseFailureMessage } from "~/state/npmRelease";
import { installLocalUpdate } from "../sidebar/SidebarUpdatePill";
import { UpdateEverythingDialog } from "../sidebar/UpdateEverythingDialog";
import {
  channelSwitchLabel,
  localSwitchBlockReason,
  type ChannelSwitchRelease,
  type UpdateEverythingConfirmation,
} from "../sidebar/updateEverything.logic";
import { isHostedByThisApp, useUpdateEverything } from "../sidebar/useUpdateEverything";
import {
  finishLocalDownload,
  localUpdaterStaysPut,
  prepareLocalTrackSwitch,
} from "./updateTrackSwitch.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Moves this app and every connected machine to `channel`. */
export function UpdateTrackSwitchDialog({
  channel,
  onClose,
}: {
  readonly channel: DesktopUpdateChannel;
  readonly onClose: () => void;
}) {
  // npm dist-tags match the desktop channel names.
  const release = useAtomValue(npmReleaseAtom(channel));
  if (AsyncResult.isSuccess(release) && release.value !== null) {
    return <SwitchPlan release={{ channel, ...release.value }} onClose={onClose} />;
  }
  const label = channelSwitchLabel(channel);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch to {label}</AlertDialogTitle>
          <AlertDialogDescription>
            {AsyncResult.isFailure(release)
              ? npmReleaseFailureMessage(release.cause)
              : AsyncResult.isSuccess(release)
                ? `Could not find the latest ${label} release in this environment's npm registry.`
                : "Checking releases…"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SwitchPlan({
  release,
  onClose,
}: {
  readonly release: ChannelSwitchRelease;
  readonly onClose: () => void;
}) {
  const updateState = useDesktopUpdateState();
  const { environments } = useEnvironments();
  const crossesLocal = desktopUpdateChannelOf(APP_VERSION) !== release.channel;
  const updatesOff = localUpdaterStaysPut(updateState, release.channel);
  // After a partial switch this app may already be on the track; then only remotes move.
  const switchesLocal = crossesLocal && !updatesOff;
  const [checking, setChecking] = useState(false);
  const everything = useUpdateEverything(switchesLocal ? release.version : null, release);
  const label = channelSwitchLabel(release.channel);
  // This dialog always asks, so a click after the running work it shows is explicit consent.
  const [checkedActivity, setCheckedActivity] = useState<UpdateEverythingConfirmation | null>(null);
  const [activityUpdatedAt, setActivityUpdatedAt] = useState<number | null>(null);
  const restartsSomething = everything.restarts.length > 0 || switchesLocal;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the machines this switch restarts for their running work while the dialog is open
  useEffect(() => {
    let current = true;
    void everything
      .checkActivity()
      .catch((): UpdateEverythingConfirmation => ({
        lines: ["Could not check the servers for running work."],
        threadActivity: [],
        localVersion: null,
        interrupts: true,
        servers: "",
      }))
      .then((activity) => {
        if (!current) return;
        setCheckedActivity(
          activity.interrupts || !restartsSomething
            ? activity
            : { ...activity, lines: ["Nothing running will be interrupted."] },
        );
        setActivityUpdatedAt(Date.now());
      });
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- One check per opening; a server still changing is re-checked when the switch runs.
  }, []);
  const activity =
    checkedActivity ??
    (restartsSomething
      ? everything.checkingActivity()
      : { lines: [], threadActivity: [], interrupts: false, localVersion: null, servers: "" });
  // This app's reinstall restarts every server it hosts, so each of their databases must allow it.
  const localBlocked = localSwitchBlockReason(
    APP_VERSION,
    release,
    environments.filter(isHostedByThisApp).map((environment) => ({
      connected: environment.connection.phase === "connected",
      databaseMigration: environment.serverConfig?.environment.databaseMigration,
    })),
    window.desktopBridge?.getLocalEnvironmentBootstraps().length ?? 0,
  );

  const run = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    // Stay open while the feed is checked; the run's own progress takes over after.
    setChecking(true);
    const fail = (description: string) =>
      toastManager.add(
        stackedThreadToast({ type: "error", title: `Could not switch to ${label}`, description }),
      );
    const prepared = await prepareLocalTrackSwitch(bridge, {
      channel: release.channel,
      version: release.version,
      reinstall: switchesLocal,
    });
    onClose();
    if (!prepared.ok) {
      fail(prepared.message);
      return;
    }
    const { local } = prepared;
    const result = await settlePromise(() =>
      everything.run({
        confirmation: activity,
        ...(local === null
          ? {}
          : {
              // This app starts its own download when a check finds a build.
              downloadLocal: (reportError) => finishLocalDownload(bridge, reportError),
              // Install only a build the database check covers, pinned so nothing replaces it.
              installLocal: async (reportError) => {
                const { downloadedVersion } = await bridge.getUpdateState();
                if (
                  downloadedVersion === null ||
                  !acceptsTrackSwitchRelease(downloadedVersion, release.channel, release.version)
                ) {
                  reportError(
                    "Could not install update",
                    `This app downloaded ${downloadedVersion ?? "nothing"}, not ${release.version} or newer.`,
                  );
                  return false;
                }
                return installLocalUpdate(bridge, reportError, downloadedVersion, true);
              },
            }),
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      fail(error instanceof Error ? error.message : "An unexpected error occurred.");
    }
  };

  return (
    <UpdateEverythingDialog
      open
      onOpenChange={(open) => !open && !checking && onClose()}
      title={`Switch to ${label}?`}
      version={release.version}
      providerCount={0}
      rows={everything.rows}
      notes={[
        ...(everything.rows.length === 0 && !crossesLocal
          ? [`Every connected machine is already on ${label}. This only saves the track.`]
          : []),
        ...(crossesLocal && updatesOff
          ? ["This app's updates are off here, so reinstall it yourself to switch."]
          : []),
        ...(switchesLocal && isMacPlatform(navigator.platform)
          ? ["If styal does not reopen after it restarts, open it again."]
          : []),
      ]}
      restarts={everything.restarts}
      activity={activity}
      checking={checkedActivity === null && restartsSomething}
      contentUpdatedAt={activityUpdatedAt}
      confirmLabel={checking ? "Checking…" : `Switch to ${label}`}
      busy={checking}
      disabledReason={
        !switchesLocal || localBlocked === null ? null : `This app cannot switch: ${localBlocked}.`
      }
      onConfirm={() => void run()}
    />
  );
}
