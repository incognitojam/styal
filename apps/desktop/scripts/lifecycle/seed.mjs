import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";

const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const decodeRun = Schema.decodeUnknownSync(OrchestrationV2RunJson);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
const timestamp = "2026-01-01T00:00:00.000Z";
const projectCount = 10;

const isWithin = (directory, target) => {
  const relative = NodePath.relative(directory, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

/** Completed-history projections only: this fixture does not measure event replay or recovery. */
export function seedLifecycleFixture(
  baseDir,
  workspaceRoot,
  { threads = 200, itemsPerThread = 40 } = {},
) {
  if (!Number.isSafeInteger(threads) || threads < 1) {
    throw new Error("threads must be a positive integer");
  }
  if (!Number.isSafeInteger(itemsPerThread) || itemsPerThread < 2 || itemsPerThread % 2 !== 0) {
    throw new Error("itemsPerThread must be a positive even integer of at least two");
  }

  const scratchRoot = NodeFS.realpathSync(
    NodeURL.fileURLToPath(new URL("../../../../.scratch", import.meta.url)),
  );
  const resolvedBaseDir = NodeFS.realpathSync(baseDir);
  const resolvedWorkspaceRoot = NodeFS.realpathSync(workspaceRoot);
  if (!isWithin(scratchRoot, resolvedBaseDir) || !isWithin(scratchRoot, resolvedWorkspaceRoot)) {
    throw new Error(
      "Lifecycle fixtures require isolated state and a synthetic workspace under this worktree's .scratch directory",
    );
  }
  const databasePath = NodePath.join(resolvedBaseDir, "userdata", "statev2.sqlite");
  if (!NodeFS.existsSync(databasePath)) {
    throw new Error("Migrate the isolated lifecycle database and stop its server before seeding");
  }
  if (!isWithin(resolvedBaseDir, NodeFS.realpathSync(databasePath))) {
    throw new Error("The lifecycle database must belong to its isolated state directory");
  }

  const database = new NodeSqlite.DatabaseSync(databasePath);
  let transactionOpen = false;
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    transactionOpen = true;
    const { count } = database
      .prepare(`
      SELECT (SELECT COUNT(*) FROM projection_projects)
        + (SELECT COUNT(*) FROM orchestration_v2_projection_threads)
        + (SELECT COUNT(*) FROM orchestration_events) AS count
    `)
      .get();
    if (count !== 0)
      throw new Error("Lifecycle fixtures require a freshly migrated, empty database");

    const insertProject = database.prepare(`
      INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (?, ?, ?, '[]', ?, ?)
    `);
    const insertThread = database.prepare(`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, payload_json)
      VALUES (?, ?, ?, 'codex', 'codex', 'full-access', 'default', ?, ?, ?, ?)
    `);
    const insertRun = database.prepare(`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at,
          completed_at, payload_json)
      VALUES (?, ?, ?, 'codex', 'codex', 'completed', ?, ?, ?)
    `);
    const insertItem = database.prepare(`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
    `);
    const insertMessage = database.prepare(`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `);
    for (let index = 0; index < projectCount; index += 1) {
      const projectRoot = NodePath.join(resolvedWorkspaceRoot, `project-${index + 1}`);
      NodeFS.mkdirSync(projectRoot, { recursive: true });
      insertProject.run(
        `lifecycle-project-${index + 1}`,
        `Synthetic project ${index + 1}`,
        projectRoot,
        timestamp,
        timestamp,
      );
    }

    for (let index = 0; index < threads; index += 1) {
      const threadId = `lifecycle-thread-${index + 1}`;
      const projectId = `lifecycle-project-${(index % projectCount) + 1}`;
      const archivedAt = index % 2 === 0 ? timestamp : null;
      const modelSelection = { instanceId: "codex", model: "synthetic" };
      const thread = {
        id: threadId,
        projectId,
        title: `Synthetic completed conversation ${index + 1}`,
        providerInstanceId: "codex",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        createdBy: "user",
        creationSource: "web",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt,
        deletedAt: null,
        settledAt: timestamp,
        settledOverride: "settled",
        lastVisitedAt: timestamp,
      };
      decodeThread(thread);
      insertThread.run(
        threadId,
        projectId,
        thread.title,
        timestamp,
        timestamp,
        archivedAt,
        JSON.stringify(thread),
      );

      for (let pair = 0; pair < itemsPerThread / 2; pair += 1) {
        const runId = `${threadId}-run-${pair + 1}`;
        const userMessageId = `${runId}-user`;
        const run = {
          id: runId,
          threadId,
          ordinal: pair + 1,
          providerInstanceId: "codex",
          modelSelection,
          providerThreadId: null,
          userMessageId,
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          checkpointId: null,
          contextHandoffId: null,
        };
        decodeRun(run);
        insertRun.run(runId, threadId, pair + 1, timestamp, timestamp, JSON.stringify(run));

        for (const role of ["user", "assistant"]) {
          const messageId = role === "user" ? userMessageId : `${runId}-assistant`;
          const text =
            role === "user"
              ? `Synthetic request ${pair + 1}: explain the behavior of a small example application and suggest a focused improvement.`
              : `Synthetic response ${pair + 1}. ${"The example reads local state, processes the requested operation, and returns a deterministic result. A focused change should preserve completed history and avoid unrelated work on the critical path. ".repeat(6)}`;
          const item = {
            id: `${messageId}-item`,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: pair * 2 + (role === "user" ? 0 : 1),
            status: "completed",
            title: null,
            startedAt: timestamp,
            completedAt: timestamp,
            updatedAt: timestamp,
            type: role === "user" ? "user_message" : "assistant_message",
            messageId,
            text,
            attachments: [],
            ...(role === "user"
              ? { createdBy: "user", creationSource: "web", inputIntent: "turn_start" }
              : { streaming: false }),
          };
          const message = {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role,
            text,
            attachments: [],
            streaming: false,
            createdBy: role === "user" ? "user" : "agent",
            creationSource: role === "user" ? "web" : "provider",
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          decodeItem(item);
          decodeMessage(message);
          insertItem.run(
            item.id,
            threadId,
            runId,
            item.ordinal,
            item.type,
            timestamp,
            JSON.stringify(item),
          );
          insertMessage.run(
            messageId,
            threadId,
            runId,
            role,
            timestamp,
            timestamp,
            JSON.stringify(message),
          );
        }
      }
    }
    database.exec("COMMIT");
    transactionOpen = false;
    return {
      kind: "completed-history-projections",
      projects: projectCount,
      threads,
      archivedThreads: Math.ceil(threads / 2),
      runs: (threads * itemsPerThread) / 2,
      turnItems: threads * itemsPerThread,
      messages: threads * itemsPerThread,
    };
  } finally {
    try {
      if (transactionOpen) database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
}
