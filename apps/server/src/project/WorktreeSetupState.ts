import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Live event commits own the transaction; replay must not backfill setup eligibility.
// EventSink already traces each commit, so streaming batches need no additional span.
export const recordSetupAttempts = Effect.fnUntraced(function* (
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  for (const { event, sequence } of events) {
    if (event.type !== "turn-item.updated" || event.payload.type !== "command_execution") continue;
    const item = event.payload;
    const setup = item.setupScript;
    if (setup === undefined || !setup.terminalId.startsWith("setup-")) continue;
    const sql = yield* SqlClient.SqlClient;
    if (item.status === "pending") {
      yield* sql`
        INSERT INTO worktree_setup_state (
          worktree_path, turn_item_id, thread_id, action_id, command, status, request_sequence
        ) VALUES (
          ${setup.worktreePath}, ${item.id}, ${item.threadId}, ${setup.scriptId}, ${item.input}, 'pending', ${sequence}
        )
        ON CONFLICT(worktree_path) DO UPDATE SET
          turn_item_id = excluded.turn_item_id, thread_id = excluded.thread_id,
          action_id = excluded.action_id, command = excluded.command, status = 'pending',
          evidence_version = NULL, device = NULL, inode = NULL, git_directory = NULL,
          request_sequence = excluded.request_sequence
        WHERE excluded.request_sequence > worktree_setup_state.request_sequence
      `;
      continue;
    }
    const status =
      item.status === "completed"
        ? "succeeded"
        : item.status === "failed"
          ? "failed"
          : item.status === "interrupted"
            ? "interrupted"
            : undefined;
    if (status === undefined) continue;
    const evidence = setup.completionEvidence;
    const identity = evidence !== undefined && evidence !== 1 ? evidence : undefined;
    yield* sql`
      UPDATE worktree_setup_state SET
        status = ${status}, evidence_version = ${evidence === 1 ? 1 : (identity?.version ?? null)},
        device = ${identity?.device ?? null}, inode = ${identity?.inode ?? null},
        git_directory = ${identity?.gitDirectory ?? null}
      WHERE worktree_path = ${setup.worktreePath} AND turn_item_id = ${item.id}
    `;
  }
});
