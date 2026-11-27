import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes } from "@t3tools/client-runtime/connection";
import { managedRelayAuthLoadAtom, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { Atom } from "effect/reactivity";
import { TriangleAlertIcon } from "lucide-react";

import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentStateHeldFor } from "../../hooks/useEnvironmentDisconnectDelay";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { environmentUpdateStatesAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "../ChatView.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  createMachineShellProgressAtom,
  machineConnectionEmptyText,
  machineConnectionLine,
} from "./machineConnectionLine.logic";

const shellProgressAtom = createMachineShellProgressAtom(
  Atom.make((get) =>
    [...get(environmentCatalog.catalogValueAtom).entries]
      .filter(([, entry]) => entry.enabled)
      .map(([id]) => id),
  ),
  environmentShell.stateValueAtom,
);

function useMachineConnections() {
  const { environments, isReady } = useEnvironments();
  const shellProgress = useAtomValue(shellProgressAtom);
  const updateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(environments.map((environment) => environment.environmentId)),
    ),
  );
  const relaySession = useAtomValue(managedRelaySessionAtom);
  const authLoad = useAtomValue(managedRelayAuthLoadAtom);
  const machines = environments.map((environment, index) => ({
    ...environment,
    hasLoadedShell: shellProgress.get(environment.environmentId)?.hasLoadedShell ?? false,
    shellError: shellProgress.get(environment.environmentId)?.shellError ?? null,
    signInLoading:
      authLoad === "loading" &&
      relaySession === null &&
      connectionRoutes(environment.entry).every(
        (route) => route.target._tag === "RelayConnectionTarget",
      ),
    outdated: environment.entry.outdated ?? null,
    enabled: environment.entry.enabled,
    updating: updateStates[index]?.status === "running",
    awaitingSignIn:
      authLoad !== "loading" &&
      relaySession === null &&
      connectionRoutes(environment.entry).every(
        (route) => route.target._tag === "RelayConnectionTarget",
      ),
  }));
  return { machines, isReady };
}

/** A footer line, like the provider update line, while a saved machine is not connected yet. */
export function SidebarMachineConnectionLine() {
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const { machines, isReady } = useMachineConnections();
  const line = machineConnectionLine(machines);
  const graceElapsed = useEnvironmentStateHeldFor(
    line?.waitingEnvironmentId ?? null,
    ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  );
  if (!isReady) {
    return (
      <span role="status" className="px-2 py-1.5 text-2xs">
        Loading saved machines…
      </span>
    );
  }
  if (line === null || (!line.showImmediately && !graceElapsed)) return null;

  const failed = line.tone === "failed";
  return (
    <div
      className={`flex min-h-7 w-full shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-2xs leading-4 font-medium ${
        failed ? "bg-warning/12 text-warning" : "bg-sidebar-control-surface text-sidebar-foreground"
      }`}
    >
      {line.machineKind === null ? (
        <TriangleAlertIcon className="size-3.5 shrink-0" />
      ) : (
        <EnvironmentMachineIcon kind={line.machineKind} className="size-3.5 shrink-0" />
      )}
      <Tooltip>
        <TooltipTrigger render={<span role="status" className="min-w-0 flex-1 truncate" />}>
          {line.text}
        </TooltipTrigger>
        {line.tooltip === null ? null : (
          <TooltipPopup side="top" className="max-w-72 whitespace-pre-line">
            {line.tooltip}
          </TooltipPopup>
        )}
      </Tooltip>
      {line.retryEnvironmentIds.length > 0 ? (
        <button
          type="button"
          className="shrink-0 cursor-pointer underline decoration-current/50 underline-offset-3 hover:decoration-current"
          onClick={() => {
            for (const environmentId of line.retryEnvironmentIds) void retryNow(environmentId);
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** The empty sidebar's text, which waits for machines that have not connected yet. */
export function SidebarNoProjectsText() {
  const { machines, isReady } = useMachineConnections();
  return <span>{machineConnectionEmptyText(machines, isReady) ?? "No projects yet"}</span>;
}
