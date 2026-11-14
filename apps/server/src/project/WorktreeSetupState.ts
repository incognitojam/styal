// @effect-diagnostics nodeBuiltinImport:off -- Completion markers must follow terminal events without adding filesystem services to the event sink.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  OrchestrationV2TurnItemJson,
  type OrchestrationV2TurnItemStatus,
  WorktreeSetupCompletionEvidence,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeTurnItem = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const terminalStatus = {
  idle: undefined,
  pending: undefined,
  running: undefined,
  waiting: undefined,
  completed: "succeeded",
  failed: "failed",
  cancelled: "interrupted",
  interrupted: "interrupted",
} as const satisfies Record<OrchestrationV2TurnItemStatus, string | undefined>;

const updateOutcome = Effect.fn("WorktreeSetupState.updateOutcome")(function* (
  worktreePath: string,
  itemId: string,
  status: "succeeded" | "failed" | "interrupted",
  evidence: typeof WorktreeSetupCompletionEvidence.Type | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const identity = status === "succeeded" && evidence !== 1 ? evidence : undefined;
  const rows = yield* sql`
    UPDATE worktree_setup_state SET
      status = ${status}, evidence_version = ${identity?.version ?? null},
      device = ${identity?.device ?? null}, inode = ${identity?.inode ?? null},
      git_directory = ${identity?.gitDirectory ?? null}
    WHERE worktree_path = ${worktreePath} AND turn_item_id = ${itemId}
    RETURNING worktree_path
  `;
  if (rows.length > 0 && identity === undefined) {
    yield* Effect.tryPromise(() =>
      NodeFSP.rm(NodePath.join(worktreePath, ".styal/setup-completed"), { force: true }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to remove setup completion marker", { itemId, cause }),
      ),
    );
  }
});

export const reconcilePendingSetupAttempts = Effect.fn(
  "WorktreeSetupState.reconcilePendingSetupAttempts",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        worktree_path: string;
        turn_item_id: string;
        payload_json: string | null;
      }>`
      SELECT setup.worktree_path, setup.turn_item_id, item.payload_json
      FROM worktree_setup_state setup
      LEFT JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = setup.turn_item_id
      WHERE setup.status = 'pending' AND (item.turn_item_id IS NULL
        OR item.status IN ('completed', 'failed', 'cancelled', 'interrupted'))
    `;
      for (const row of rows) {
        const item =
          row.payload_json === null ? undefined : yield* decodeTurnItem(row.payload_json);
        yield* updateOutcome(
          row.worktree_path,
          row.turn_item_id,
          item === undefined ? "interrupted" : (terminalStatus[item.status] ?? "interrupted"),
          item?.type === "command_execution" ? item.setupScript?.completionEvidence : undefined,
        );
      }
    }),
  );
});

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
    const status = terminalStatus[item.status];
    if (status === undefined) continue;
    yield* updateOutcome(setup.worktreePath, item.id, status, setup.completionEvidence);
  }
});
