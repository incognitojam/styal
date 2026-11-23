import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes } from "@t3tools/client-runtime/connection";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { TriangleAlertIcon } from "lucide-react";

import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentStateHeldFor } from "../../hooks/useEnvironmentDisconnectDelay";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { environmentUpdateStatesAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "../ChatView.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { machineConnectionEmptyText, machineConnectionLine } from "./machineConnectionLine.logic";

function useMachineConnections() {
  const { environments } = useEnvironments();
  const updateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(environments.map((environment) => environment.environmentId)),
    ),
  );
  const relaySession = useAtomValue(managedRelaySessionAtom);
  return environments.map((environment, index) => ({
    ...environment,
    updating: updateStates[index]?.status === "running",
    awaitingSignIn:
      relaySession === null &&
      connectionRoutes(environment.entry).every(
        (route) => route.target._tag === "RelayConnectionTarget",
      ),
  }));
}

/** A footer line, like the provider update line, while a saved machine is not connected yet. */
export function SidebarMachineConnectionLine() {
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const line = machineConnectionLine(useMachineConnections());
  // Machines that connect within a moment never show the line.
  const graceElapsed = useEnvironmentStateHeldFor(
    line?.waitingEnvironmentId ?? null,
    ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  );
  if (line === null || !graceElapsed) return null;

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
      <span role="status" className="min-w-0 flex-1 truncate">
        {line.text}
      </span>
      {failed ? (
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
  return <span>{machineConnectionEmptyText(useMachineConnections()) ?? "No projects yet"}</span>;
}
