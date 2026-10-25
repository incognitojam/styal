import type {
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
} from "@t3tools/contracts";

/**
 * Sent with a forked thread's first turn. The copied history can end mid-task,
 * and the agent would otherwise take its source's background work, and the
 * work that continued in the source, for its own interrupted work.
 */
export const FORK_NOTE =
  "Note: this thread is a fork of another thread. The earlier conversation was copied from that thread up to the response the user forked from. Work may have continued in that thread since then. Background work started before the fork, such as commands, monitors and subagents, belongs to that thread and will not report back here.";

/**
 * Sent until a forked thread's provider turn completes, so a refused or restarted turn resends it.
 * Restart continuations and provider-created messages skip it. Provider commands such as /compact
 * must start their text, so they skip it too; if that turn completes, the fork gets no note.
 */
export function shouldSendForkNote(input: {
  readonly threadId: string;
  readonly run: Pick<OrchestrationV2Run, "restartContinuationOfRunId">;
  readonly message: {
    readonly text: string;
    readonly creationSource: OrchestrationV2CreationSource;
    readonly attachments: ReadonlyArray<unknown>;
  };
  readonly contextTransfers: ReadonlyArray<
    Pick<OrchestrationV2ContextTransfer, "type" | "targetThreadId">
  >;
  readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "status">>;
}): boolean {
  return (
    input.run.restartContinuationOfRunId === undefined &&
    input.message.creationSource !== "provider" &&
    // Matches how turn start recognizes a provider command.
    !(input.message.attachments.length === 0 && input.message.text.trimStart().startsWith("/")) &&
    input.contextTransfers.some(
      (transfer) => transfer.type === "fork" && transfer.targetThreadId === input.threadId,
    ) &&
    !input.providerTurns.some((turn) => turn.status === "completed")
  );
}
