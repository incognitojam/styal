import { useStableCallback } from "../../hooks/useStableCallback";
import { type EnvironmentId } from "@t3tools/contracts";
import { type EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { useAtomValue } from "@effect/atom-react";
import { lazy, Suspense, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { LogInIcon, WifiOffIcon } from "lucide-react";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { environmentCatalog } from "../../connection/catalog";
import { ConnectionDiagnosisHeadline } from "../settings/ConnectionDiagnosisDetails";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  useEnvironmentDisconnectDelay,
  useEnvironmentStateHeldFor,
} from "../../hooks/useEnvironmentDisconnectDelay";
import { serverEnvironment } from "../../state/server";
import { type EnvironmentPresentation } from "../../state/environments";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "../ChatView.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ServerUpdateAction, serverUpdateStageLabel } from "../ServerUpdateAction";
import { useAutoBalanceUpdateBanner } from "./useAutoBalanceUpdateBanner";
import { ComposerServerUpdateIcon } from "./ComposerServerUpdateStatus";
import {
  dismissServerUpdateFailure,
  isServerUpdateFailureDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "../../versionSkew";

const T3ConnectSignInButton = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSignInButton,
  })),
);

export type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
  /** Why a styal Link environment has no cloud session to connect with, if it has none. */
  readonly missingCloudSession: "loading" | "failed" | "signed-out" | null;
};

interface SystemComposerBannersInput {
  readonly activeEnvironment: EnvironmentPresentation | null;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableState: EnvironmentUnavailableState | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly serverConfig: EnvironmentPresentation["serverConfig"] | null;
  readonly hasMultipleRegisteredEnvironments: boolean;
  readonly automaticEnvironment: boolean;
  readonly autoUpdateEnvironments: ReadonlyArray<EnvironmentPresentation>;
}

/**
 * The composer banners about the machine itself: offline or reconnecting,
 * a server update, and auto-balanced machines that need one.
 */
export function useSystemComposerBanners(input: SystemComposerBannersInput) {
  const {
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState,
    activeThreadEnvironmentId,
    serverConfig,
    hasMultipleRegisteredEnvironments,
    automaticEnvironment,
    autoUpdateEnvironments,
  } = input;
  const navigate = useNavigate();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  // Each reconnect attempt gets its own grace period, including a later one to
  // the same environment.
  const reconnectWarningGraceElapsed = useEnvironmentStateHeldFor(
    activeReconnectingEnvironmentId,
    ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  );
  const handleReconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    const result = await retryEnvironment(environmentId);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect environment",
          description: error instanceof Error ? error.message : "Failed to reconnect.",
        }),
      );
    }
  };
  const handleReconnectActiveEnvironmentStable = useStableCallback(
    handleReconnectActiveEnvironment,
  );
  const disconnectDelayElapsed = useEnvironmentDisconnectDelay(
    activeEnvironmentUnavailable && activeEnvironment ? activeEnvironment.environmentId : null,
  );
  const canDisconnectActiveEnvironment =
    disconnectDelayElapsed &&
    activeEnvironment !== null &&
    activeEnvironment.entry.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(activeEnvironment.entry.target);
  const [disconnectingEnvironment, setDisconnectingEnvironment] = useState(false);
  const handleDisconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    setDisconnectingEnvironment(true);
    const result = await setEnvironmentEnabled({ environmentId, enabled: false });
    setDisconnectingEnvironment(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not disconnect server",
            description: error instanceof Error ? error.message : "Failed to disconnect.",
          }),
        );
      }
      return;
    }
    void navigate({ to: "/", replace: true });
  };
  const handleDisconnectActiveEnvironmentStable = useStableCallback(
    handleDisconnectActiveEnvironment,
  );
  const autoBalanceUpdateBanner = useAutoBalanceUpdateBanner(autoUpdateEnvironments);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThreadEnvironmentId !== null
      ? `${activeEnvironment?.label ?? serverConfig?.environment.label ?? activeThreadEnvironmentId} server`
      : "server";
  const serverUpdateEnvironmentId = activeThreadEnvironmentId;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const versionMismatchInstallation = serverConfig?.environment.capabilities.serverInstallation;
  const versionMismatchDesktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  const [dismissedServerUpdateState, setDismissedServerUpdateState] = useState<
    typeof serverUpdateState | null
  >(null);
  const serverUpdateFailureDismissed =
    serverUpdateState === dismissedServerUpdateState ||
    isServerUpdateFailureDismissed(serverUpdateState);
  return (() => {
    const items: ComposerBannerStackItem[] = [];
    const updateRunning = serverUpdateState.status === "running";
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const disconnectAction =
      canDisconnectActiveEnvironment && activeEnvironmentUnavailableState ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disconnectingEnvironment}
          title="Hide this environment's threads. Switch it on again in Environments."
          onClick={() =>
            void handleDisconnectActiveEnvironmentStable(
              activeEnvironmentUnavailableState.environmentId,
            )
          }
        >
          Disconnect server
        </Button>
      ) : undefined;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    // While an update runs, transient connect blips are expected (the server
    // restarts) and the update banner already shows progress. Hard failure
    // phases still surface so the Reconnect action stays reachable.
    // Until the sign-in loads there is nothing to act on; it settles within seconds.
    const suppressUnavailableBanner =
      activeEnvironmentUnavailableState?.missingCloudSession === "loading" ||
      (environmentReconnecting && (updateRunning || !reconnectWarningGraceElapsed));
    if (activeEnvironmentUnavailableState && unavailableConnection && !suppressUnavailableBanner) {
      if (activeEnvironmentUnavailableState.missingCloudSession === "failed") {
        // Clerk loads once per page, so only a reload retries it.
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: "warning",
          group: "environment",
          icon: <WifiOffIcon />,
          title: "Can't reach styal Link sign-in",
          description: `Check your connection, then reload to reach ${activeEnvironmentUnavailableState.label}.`,
          actions: (
            <>
              <Button size="xs" variant="ghost" onClick={() => window.location.reload()}>
                Reload
              </Button>
              {disconnectAction}
            </>
          ),
        });
      } else if (
        activeEnvironmentUnavailableState.missingCloudSession === "signed-out" &&
        unavailableConnection.phase === "error"
      ) {
        // Reconnect cannot help without a cloud session; signing in retries the
        // connection on its own.
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: "warning",
          group: "environment",
          icon: <LogInIcon />,
          title: `Sign in to styal Link to reach ${activeEnvironmentUnavailableState.label}`,
          actions: (
            <>
              <Suspense fallback={null}>
                <T3ConnectSignInButton />
              </Suspense>
              {disconnectAction}
            </>
          ),
        });
      } else {
        const connectionFailed = unavailableConnection.phase === "error";
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: connectionFailed ? "error" : "warning",
          group: "environment",
          icon: <WifiOffIcon />,
          title: `${activeEnvironmentUnavailableState.label} is ${
            environmentReconnecting ? "reconnecting" : connectionFailed ? "unavailable" : "offline"
          }`,
          description: activeEnvironment ? (
            <ConnectionDiagnosisHeadline environment={activeEnvironment} />
          ) : connectionFailed ? (
            unavailableConnection.error
          ) : undefined,
          actions: (
            <>
              {!environmentReconnecting ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    void handleReconnectActiveEnvironmentStable(
                      activeEnvironmentUnavailableState.environmentId,
                    )
                  }
                >
                  Reconnect
                </Button>
              ) : null}
              {disconnectAction}
            </>
          ),
        });
      }
    }
    // An available update is offered by the sidebar's update pill; the composer only shows one
    // that is running or failed, since either explains what this thread's server is doing.
    if (
      !automaticEnvironment &&
      serverUpdateEnvironmentId &&
      serverUpdateState.status !== "idle" &&
      !serverUpdateFailureDismissed
    ) {
      const updateFailed = serverUpdateState.status === "failed";
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: updateFailed ? "error" : "default",
        group: "environment",
        icon: <ComposerServerUpdateIcon status={serverUpdateState.status} />,
        title: `${updateFailed ? "Could not update" : "Updating"} ${versionMismatchServerLabel}`,
        description:
          serverUpdateState.status === "failed"
            ? serverUpdateState.message
            : serverUpdateStageLabel(serverUpdateState.stage),
        actions: !updateFailed ? (
          disconnectAction
        ) : !versionMismatch ||
          (versionMismatchSelfUpdate === "desktop-managed" &&
            !versionMismatchDesktopAppUpdate) ? undefined : (
          <ServerUpdateAction
            environmentId={serverUpdateEnvironmentId}
            serverLabel={versionMismatchServerLabel}
            selfUpdate={versionMismatchSelfUpdate}
            installation={versionMismatchInstallation}
            desktopAppUpdate={versionMismatchDesktopAppUpdate}
            targetVersion={versionMismatch.clientVersion}
            label="Retry"
            variant="ghost"
          />
        ),
        ...(updateFailed
          ? {
              dismissLabel: "Dismiss update notice",
              onDismiss: () => {
                dismissServerUpdateFailure(serverUpdateState);
                setDismissedServerUpdateState(serverUpdateState);
              },
            }
          : {}),
      });
    }
    if (autoBalanceUpdateBanner) items.push(autoBalanceUpdateBanner);
    return items;
  })() as ComposerBannerStackItem[];
}
