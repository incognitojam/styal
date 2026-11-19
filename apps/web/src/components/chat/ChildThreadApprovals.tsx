import { AuthOrchestrationOperateScope, type ProviderApprovalDecision } from "@t3tools/contracts";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { fullAccessOverrideExplanation } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ComposerPendingApprovalActions,
  DEFAULT_APPROVAL_OPTIONS,
} from "./ComposerPendingApprovalActions";

/** The answer to a subagent's approval, under the row that says what it asks and whose it is. */
export function ChildApproval({
  entry,
  onResponded,
}: {
  entry: ChildThreadApproval;
  onResponded?: (decision: ProviderApprovalDecision) => void;
}) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval } = entry;
  // The person is looking at the parent, so a grant for "this session" names the child it covers.
  const options = (approval.options ?? DEFAULT_APPROVAL_OPTIONS).map((option) =>
    option.decision === "acceptForSession"
      ? { ...option, label: `${option.label} in “${entry.title}”` }
      : option,
  );
  return (
    <div className="flex flex-col gap-2 text-xs">
      {approval.appName ? <p className="text-muted-foreground">{approval.appName}</p> : null}
      {approval.responseCapability !== "live" ? (
        <p className="text-warning">
          Provider process is gone. Interrupt or restart the child thread to respond.
        </p>
      ) : null}
      {approval.reason ? <p className="text-muted-foreground">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          isResponding={responding}
          canRespond={approval.responseCapability === "live"}
          disabled={!canRespond}
          options={options}
          onRespondToApproval={async (requestId, decision) => {
            if (!canRespond || responding) return;
            setResponding(true);
            setError(null);
            const result = await respond({
              environmentId: entry.thread.environmentId,
              input: { threadId: entry.thread.threadId, requestId, decision },
            });
            if (result._tag === "Success") onResponded?.(decision);
            else if (!isAtomCommandInterrupted(result)) {
              const failure = squashAtomCommandFailure(result);
              setError(
                failure instanceof Error ? failure.message : "Failed to submit approval decision.",
              );
            }
            setResponding(false);
            return result;
          }}
        />
      </div>
      {error !== null ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
