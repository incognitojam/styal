#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Synchronous fixture writes to an isolated development database.

/** Ephemeral visual fixture only: stop the dev server before writing its projections. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import { providerToolFixtures } from "../src/mcp/toolkits/testing/toolPresentationFixtures.ts";

const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const decodeRun = Schema.decodeUnknownSync(OrchestrationV2RunJson);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

const { values } = NodeUtil.parseArgs({
  options: {
    "base-dir": { type: "string" },
    "workspace-root": { type: "string" },
  },
});
if (!values["base-dir"] || !values["workspace-root"]) {
  throw new Error(
    "Usage: seed-tool-presentation-fixture.ts --base-dir <isolated-dev-home> --workspace-root <synthetic-workspace>",
  );
}
const baseDir = NodeFS.realpathSync(values["base-dir"]);
for (const name of [".styal", ".t3"]) {
  const liveHome = NodePath.join(NodeOS.homedir(), name);
  if (NodeFS.existsSync(liveHome) && baseDir === NodeFS.realpathSync(liveHome)) {
    throw new Error("Use an isolated development home, not the shared install");
  }
}
const databasePath = NodePath.join(baseDir, "userdata/statev2.sqlite");
if (!NodeFS.existsSync(databasePath))
  throw new Error("Start the isolated dev server once to run migrations, then stop it");
const workspaceRoot = NodeFS.realpathSync(values["workspace-root"]);
const fixtures = await providerToolFixtures();
const database = new NodeSqlite.DatabaseSync(databasePath);
const timestamp = "2026-01-01T00:00:00.000Z";
const projectId = "tool-wording-fixture-project";
const json = (value: unknown) => JSON.stringify(value);
const sampleInput = (tool: string) => {
  switch (tool) {
    case "preview_open":
    case "preview_navigate":
      return { url: "https://example.com/demo" };
    case "preview_click":
      return { locator: "role=button[name='Save']" };
    case "preview_type":
      return { text: "Synthetic example" };
    case "preview_press":
      return { key: "Enter" };
    case "preview_resize":
      return { mode: "freeform", width: 1024, height: 768 };
    case "preview_scroll":
      return { deltaY: 300 };
    case "preview_wait_for":
      return { text: "Ready" };
    case "preview_evaluate":
      return { expression: "document.title" };
    case "preview_set_appearance":
      return { colorScheme: "dark" };
    default:
      return {};
  }
};

try {
  database.exec("BEGIN IMMEDIATE");
  for (const table of [
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_threads",
  ]) {
    database
      .prepare(
        `DELETE FROM ${table} WHERE thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id = ?)`,
      )
      .run(projectId);
  }
  database
    .prepare(`INSERT OR REPLACE INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (?, ?, ?, '[]', ?, ?)`)
    .run(projectId, "Tool wording fixtures", workspaceRoot, timestamp, timestamp);
  const groups = Map.groupBy(fixtures, ({ provider, server }) => `${provider} / ${server}`);
  for (const [group, tools] of groups) {
    const threadId = `tool-wording-${group.replaceAll(/[^a-zA-Z0-9]/gu, "-")}`;
    const runId = `${threadId}-run`;
    const messageId = `${threadId}-request`;
    const modelSelection = { instanceId: "codex", model: "synthetic" };
    const thread = {
      id: threadId,
      projectId,
      title: group,
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
      archivedAt: null,
      deletedAt: null,
      settledAt: null,
      settledOverride: null,
      lastVisitedAt: null,
    };
    decodeThread(thread);
    database
      .prepare(`INSERT OR REPLACE INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, 'codex', 'codex', 'full-access', 'default', ?, ?, ?)`)
      .run(threadId, projectId, group, timestamp, timestamp, json(thread));
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection,
      providerThreadId: null,
      userMessageId: messageId,
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
    database
      .prepare(`INSERT OR REPLACE INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      VALUES (?, ?, 1, 'codex', 'codex', 'completed', ?, ?, ?)`)
      .run(runId, threadId, timestamp, timestamp, json(run));
    const insert = database.prepare(`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    let ordinal = 0;
    const add = (body: Record<string, unknown>) => {
      const item = {
        id: `${threadId}-item-${ordinal}`,
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: ordinal++,
        status: "completed",
        title: null,
        startedAt: timestamp,
        completedAt: timestamp,
        updatedAt: timestamp,
        ...body,
      };
      decodeItem(item);
      insert.run(
        item.id,
        threadId,
        runId,
        item.ordinal,
        String(body.type),
        item.status,
        timestamp,
        json(item),
      );
    };
    add({
      type: "user_message",
      messageId,
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      text: `Synthetic presentation catalog: ${group}`,
      attachments: [],
    });
    for (const tool of tools) {
      add({
        type: "dynamic_tool",
        toolName: tool.toolName,
        input: sampleInput(tool.tool),
        output: { synthetic: true },
      });
    }
    for (const status of ["running", "failed", "cancelled"] as const) {
      const preview = tools.find(({ tool }) => tool === "preview_click");
      if (preview)
        add({
          type: "dynamic_tool",
          toolName: preview.toolName,
          input: sampleInput(preview.tool),
          status,
        });
    }
  }
  database.exec("COMMIT");
  process.stdout.write(
    `Seeded ${fixtures.length} synthetic tool calls in ${Map.groupBy(fixtures, ({ provider, server }) => `${provider} / ${server}`).size} threads.\n`,
  );
} finally {
  database.close();
}
