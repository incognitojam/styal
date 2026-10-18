import { useAtomValue } from "@effect/atom-react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { AuthRelayReadScope, AuthRelayWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { stackedThreadToast } from "../components/ui/toastHelpers";
import { relayFailureReason } from "./relayFailureReason";
import { relayEnvironmentDiscovery } from "../state/relay";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { isCloudEnvironmentLinkError } from "./linkEnvironment";
import { refreshManagedTunnelUsage } from "./managedRelayState";
import {
  linkEnvironment as linkEnvironmentAtom,
  unlinkEnvironment as unlinkEnvironmentAtom,
  updateEnvironmentPreferences as updateEnvironmentPreferencesAtom,
} from "./linkEnvironmentAtoms";
import { readCachedCloudLinkState, useCloudLinkState } from "./cloudLinkState";
import { isManagedTunnelActive } from "./t3ConnectState";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}

/**
 * The managed tunnel and agent-activity publishing share one relay link, so callers pass the full
 * desired state. Re-linking happens only when the tunnel mode changes; toggling publish alone is cheap.
 */
const isManagedRelayRequestFailedError = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isManagedRelayClientError = Schema.is(ManagedRelay.ManagedRelayClientError);

/** The account's tunnel cap when the relay refused a new tunnel for being at it. */
function tunnelLimitFromLinkFailure(cause: unknown): number | null {
  if (!isCloudEnvironmentLinkError(cause)) return null;
  const relayCause = cause.cause;
  if (!isManagedRelayRequestFailedError(relayCause)) return null;
  return relayCause.relayError?._tag === "RelayEnvironmentLinkLimitExceededError"
    ? relayCause.relayError.maxTunnels
    : null;
}

export function useCloudLinkController(environmentId: EnvironmentId | null) {
  const session = useAtomValue(managedRelaySessionAtom);
  const isSignedIn = session !== null;
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkEnvironment = useAtomCommand(linkEnvironmentAtom, {
    reportFailure: false,
  });
  const unlinkEnvironment = useAtomCommand(unlinkEnvironmentAtom, {
    reportFailure: false,
  });
  const updateEnvironmentPreferences = useAtomCommand(updateEnvironmentPreferencesAtom, {
    reportFailure: false,
  });
  const cloudLinkState = useCloudLinkState(environmentId);
  const relayEnvironments = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments;
  const relayProviderKind = environmentId
    ? relayEnvironments.get(environmentId)?.environment.endpoint.providerKind
    : undefined;
  const [operationError, setOperationError] = useState<string | null>(null);
  const [tunnelLimit, setTunnelLimit] = useState<number | null>(null);

  const reportUpdateFailure = (cause: unknown, reason?: string) => {
    const message = cause instanceof Error ? cause.message : "Could not update styal Link access.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not update styal Link", { message, traceId, cause });
    setOperationError(traceId ? `${message} Trace ID: ${traceId}` : message);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not update styal Link",
        description: reason ?? relayFailureReason(cause) ?? message,
        ...(traceId
          ? {
              actionProps: {
                children: "Copy trace ID",
                onClick: () => void navigator.clipboard?.writeText(traceId),
              },
              actionVariant: "outline",
            }
          : {}),
        data: { hideCopyButton: true },
      }),
    );
  };

  const linkData = cloudLinkState.data;
  const linkRevoked = linkData?.linkRevoked ?? false;
  const managedTunnelActive = linkData ? isManagedTunnelActive(linkData, relayProviderKind) : false;
  const managedTunnelOutOfSync =
    linkData !== null && !managedTunnelActive && isManagedTunnelActive(linkData, undefined);
  const publishAgentActivity = cloudLinkState.data?.publishAgentActivity ?? false;
  const holdWebhooksWhileOffline = cloudLinkState.data?.holdWebhooksWhileOffline ?? false;
  const linked = !linkRevoked && (cloudLinkState.data?.linked ?? false);

  const reconcileCloudState = async (desired: CloudLinkDesiredState): Promise<boolean> => {
    setOperationError(null);
    setTunnelLimit(null);
    const target = cloudLinkState.target;
    if (!target) {
      reportUpdateFailure(new Error("Choose an environment first."));
      return false;
    }
    const environmentId = target.environmentId;
    const canManageLink = () => {
      if (
        !readEnvironmentScope(environmentId, AuthRelayReadScope) ||
        !readEnvironmentScope(environmentId, AuthRelayWriteScope)
      ) {
        reportUpdateFailure(
          new Error("This connection needs permission to view and manage styal Link settings."),
        );
        return false;
      }
      return true;
    };
    const readLinkState = () => {
      const state = readCachedCloudLinkState(target);
      if (state === null) {
        reportUpdateFailure(new Error("Wait until the current styal Link settings can be read."));
      }
      return state;
    };
    if (!canManageLink()) return false;
    const wantsLink = desired.managedTunnel || desired.publish;
    if (wantsLink && readLinkState() === null) return false;
    const credential = session?.credential ?? null;

    // A failed mutation may have partially applied, so refresh server state on every exit.
    if (!wantsLink) {
      // Unlink works signed out too, so the user can always turn styal Link off.
      const unlinkResult = await unlinkEnvironment({ target, credential });
      refreshManagedTunnelUsage();
      if (unlinkResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(unlinkResult)) {
          const cause = squashAtomCommandFailure(unlinkResult);
          // Only the relay delete fails with a relay error, and it runs after the local unlink.
          const relayKeptLink =
            isCloudEnvironmentLinkError(cause) && isManagedRelayClientError(cause.cause);
          reportUpdateFailure(
            cause,
            relayKeptLink
              ? "Disconnected here, but styal Link still lists it. Remove it in Account."
              : undefined,
          );
        }
        cloudLinkState.refresh();
        await refreshRelayEnvironments();
        return false;
      }
    } else {
      const currentLinkState = readLinkState();
      if (currentLinkState === null) return false;
      if (!credential) {
        reportUpdateFailure(new Error("Sign in to styal Link before enabling this."));
        return false;
      }
      const currentManagedTunnel = isManagedTunnelActive(currentLinkState, relayProviderKind);
      if (
        !currentLinkState.linked ||
        currentLinkState.linkRevoked === true ||
        currentManagedTunnel !== desired.managedTunnel
      ) {
        const linkResult = await linkEnvironment({
          target,
          credential,
          mode: desired.managedTunnel ? "managed" : "publish_only",
        });
        // Any link attempt can change the account's tunnel count.
        refreshManagedTunnelUsage();
        if (linkResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(linkResult)) {
            const cause = squashAtomCommandFailure(linkResult);
            // Callers show recovery guidance for a tunnel cap refusal.
            const limit = tunnelLimitFromLinkFailure(cause);
            if (limit === null) reportUpdateFailure(cause);
            else setTunnelLimit(limit);
          }
          cloudLinkState.refresh();
          return false;
        }
      }
      if (!canManageLink() || readLinkState() === null) {
        cloudLinkState.refresh();
        return false;
      }
      const prefResult = await updateEnvironmentPreferences({
        target,
        publishAgentActivity: desired.publish,
        ...(desired.holdWebhooksWhileOffline === undefined
          ? {}
          : { holdWebhooksWhileOffline: desired.holdWebhooksWhileOffline }),
      });
      if (prefResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(prefResult)) {
          reportUpdateFailure(squashAtomCommandFailure(prefResult));
        }
        cloudLinkState.refresh();
        return false;
      }
    }

    cloudLinkState.refresh();
    const refreshResult = await refreshRelayEnvironments();
    if (refreshResult._tag === "Failure" && !isAtomCommandInterrupted(refreshResult)) {
      reportUpdateFailure(squashAtomCommandFailure(refreshResult));
      return false;
    }
    return true;
  };

  return {
    isSignedIn,
    linkState: cloudLinkState,
    linked,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    tunnelLimit,
    reconcileCloudState,
  };
}
