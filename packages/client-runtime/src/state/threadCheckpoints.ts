import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointFileTotals,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  /** A prefix of the changed files when `filesTotal` is set; see `checkpointFileTotals`. */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly filesTotal?: OrchestrationV2CheckpointFileTotals;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

/** Derives the checkpoint/diff rows needed by review UIs from V2 entities, including frozen historical checkpoints. */
export function deriveThreadCheckpointSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "checkpoints">,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    const count = checkpoint.legacyCheckpointTurnCount ?? checkpoint.appRunOrdinal;
    if (count === null || (checkpoint.runId === null && checkpoint.legacyTurnId === undefined))
      return [];
    const assistantMessageId =
      checkpoint.assistantMessageId ??
      projection.messages.findLast(
        (message) =>
          message.role === "assistant" &&
          (checkpoint.legacyTurnId !== undefined
            ? message.legacyTurnId === checkpoint.legacyTurnId
            : message.runId === checkpoint.runId),
      )?.id ??
      null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        // This is a review selection key for runless frozen history, never a native run.
        runId: checkpoint.runId ?? RunId.make(`legacy-checkpoint:${checkpoint.id}`),
        checkpointTurnCount: count,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        ...(checkpoint.filesTotal === undefined ? {} : { filesTotal: checkpoint.filesTotal }),
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

export function checkpointFileTotals(
  checkpoint: Pick<ThreadCheckpointSummary, "files" | "filesTotal">,
): OrchestrationV2CheckpointFileTotals {
  if (checkpoint.filesTotal !== undefined) return checkpoint.filesTotal;
  let additions = 0;
  let deletions = 0;
  for (const file of checkpoint.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { count: checkpoint.files.length, additions, deletions };
}
