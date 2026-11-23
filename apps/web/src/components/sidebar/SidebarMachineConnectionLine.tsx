import { TriangleAlertIcon, WifiIcon } from "lucide-react";

import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentStateHeldFor } from "../../hooks/useEnvironmentDisconnectDelay";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "../ChatView.logic";
import { machineConnectionEmptyText, machineConnectionLine } from "./machineConnectionLine.logic";

/** A footer line, like the provider update line, while a saved machine is not connected yet. */
export function SidebarMachineConnectionLine() {
  const { environments } = useEnvironments();
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const line = machineConnectionLine(environments);
  // Machines that connect within a moment never show the line.
  const graceElapsed = useEnvironmentStateHeldFor(
    line?.waitingEnvironmentId ?? null,
    ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  );
  if (line === null || !graceElapsed) return null;

  const failed = line.tone === "failed";
  return (
    <div
      role="status"
      className={`flex min-h-7 w-full shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-2xs leading-4 font-medium ${
        failed ? "bg-warning/12 text-warning" : "bg-sidebar-control-surface text-sidebar-foreground"
      }`}
    >
      {failed ? (
        <TriangleAlertIcon className="size-3.5 shrink-0" />
      ) : (
        <WifiIcon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{line.text}</span>
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
  const { environments } = useEnvironments();
  return <span>{machineConnectionEmptyText(environments) ?? "No projects yet"}</span>;
}
