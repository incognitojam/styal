// @effect-diagnostics nodeBuiltinImport:off - Offline SQLite tooling needs synchronous Node file and descriptor operations.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { isLivePath } from "./safety.ts";
import { schemaKeys } from "./codecs.ts";
import objects from "./sourceObjects.json" with { type: "json" };

// Run with an offline checkout of 68e0ea592ac9a2262d04f2457d83e3f21d73ac73.
// The source's Effect version and migrations must come from the same checkout.
const root = NodePath.resolve(process.argv[2]!);
const output = NodePath.resolve(process.argv[3]!);
if (
  NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== "68e0ea592ac9a2262d04f2457d83e3f21d73ac73"
)
  throw new Error("Unrecognised fixture source revision");
if (
  isLivePath(root) ||
  isLivePath(output) ||
  isLivePath(NodeFS.realpathSync(root)) ||
  isLivePath(NodeFS.realpathSync(NodePath.dirname(output))) ||
  (NodeFS.existsSync(output) && isLivePath(NodeFS.realpathSync(output)))
)
  throw new Error("Live paths are forbidden for fixtures");
const requireSource = NodeModule.createRequire(NodePath.join(root, "apps/server/package.json"));
const Effect = await import(NodeURL.pathToFileURL(requireSource.resolve("effect/Effect")).href);
const Sqlite = await import(
  NodeURL.pathToFileURL(NodePath.join(root, "packages/shared/src/nodeSqliteClient.ts")).href
);
const Migrations = await import(
  NodeURL.pathToFileURL(NodePath.join(root, "apps/server/src/persistence/ForkMigrations.ts")).href
);
const Contracts = await import(
  NodeURL.pathToFileURL(NodePath.join(root, "packages/contracts/src/index.ts")).href
);
NodeFS.mkdirSync(output, { recursive: true });
const filename = NodePath.join(output, "source.sqlite");
if (NodeFS.existsSync(filename)) throw new Error("Fixture already exists");
await Effect.runPromise(
  Migrations.runAllMigrations().pipe(Effect.provide(Sqlite.layer({ filename })), Effect.scoped),
);
const db = new NodeSqlite.DatabaseSync(filename);
db.exec("BEGIN");
const Schema = await import(NodeURL.pathToFileURL(requireSource.resolve("effect/Schema")).href);
const decodeEvent = Schema.decodeUnknownSync(Contracts.OrchestrationV2DomainEventJson);
const decodeThread = Schema.decodeUnknownSync(Contracts.OrchestrationV2AppThreadJson);
const encodeThread = Schema.encodeUnknownSync(Contracts.OrchestrationV2AppThreadJson);
const at = "2026-01-01T00:00:00.000Z";
let sequence = 0;
function insert(table: string, values: Record<string, string | number | null>) {
  const names = Object.keys(values);
  db.prepare(
    `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...Object.values(values));
}
function event(threadId: string, type: string, payload: unknown, streamVersion = 1) {
  decodeEvent({
    id: `event-${++sequence}`,
    threadId,
    type,
    occurredAt: at,
    payload,
  });
  insert("orchestration_events", {
    event_id: `event-${sequence}`,
    aggregate_kind: "thread",
    stream_id: threadId,
    stream_version: streamVersion,
    event_type: type,
    occurred_at: at,
    actor_kind: "server",
    payload_json: JSON.stringify(payload),
    metadata_json: "{}",
    application_event_version: 2,
  });
}
function thread(id: string, extra: Record<string, unknown> = {}, retained = true) {
  const raw = {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: "project-alpha",
    title: "Project Alpha",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
    ...extra,
  };
  const payload = encodeThread(decodeThread(raw));
  insert("orchestration_v2_projection_threads", {
    thread_id: id,
    project_id: "project-alpha",
    title: "Project Alpha",
    default_provider: "codex",
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_at: at,
    updated_at: at,
    archived_at: payload.archivedAt,
    deleted_at: payload.deletedAt,
    payload_json: JSON.stringify(payload),
  });
  if (retained) event(id, "thread.created", payload);
  return payload;
}
insert("projection_projects", {
  project_id: "project-alpha",
  title: "Project Alpha",
  workspace_root: "/synthetic/project-alpha",
  scripts_json: "[]",
  created_at: at,
  updated_at: at,
});
thread("ordinary");
thread("snapshot-only", {}, false);
thread("archived", { archivedAt: at });
thread("deleted", { deletedAt: at });
thread("fork", {
  lineage: { parentThreadId: "ordinary", relationshipToParent: "fork", rootThreadId: "ordinary" },
  forkedFrom: { type: "run", threadId: "ordinary", runId: "run-alpha" },
  forkHistoryMaterialized: true,
});
thread("orphan-fork", {
  lineage: {
    parentThreadId: "missing-parent",
    relationshipToParent: "fork",
    rootThreadId: "missing-parent",
  },
  forkedFrom: { type: "run", threadId: "missing-parent", runId: "run-missing" },
  forkHistoryMaterialized: true,
});
thread("fork-fields", {
  reportTo: { threadId: "ordinary" },
  reportDismissals: [
    {
      id: "dismissal-alpha",
      messageId: "message-alpha",
      key: "alpha",
      version: 1,
      occurredAt: at,
      text: "Synthetic summary",
    },
  ],
  answerNotes: [{ id: "answer-alpha", text: "Synthetic answer", occurredAt: at }],
  workflowRuns: [
    {
      host: "github.com",
      repository: "example/project-alpha",
      runId: 1,
      url: "https://github.com/example/project-alpha/actions/runs/1",
      name: "Synthetic workflow",
      startedAt: at,
    },
  ],
  authRecovery: { runId: "run-alpha", waiting: true, signedOutSeen: false },
  settleReason: { kind: "user" },
});
const brokenOptions = thread("model-options-string", {}, false);
(brokenOptions.modelSelection as Record<string, unknown>).options =
  '[{"id":"effort","value":"low"}]';
db.prepare(
  "UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = 'model-options-string'",
).run(JSON.stringify(brokenOptions));
for (const id of ["legacy-only", "legacy-imported"])
  insert("projection_threads", {
    thread_id: id,
    project_id: "project-alpha",
    title: "Synthetic legacy thread",
    created_at: at,
    updated_at: at,
  });
thread("legacy-imported", { historyOrigin: "v1_import" });
insert("orchestration_v2_legacy_imports", {
  thread_id: "legacy-imported",
  source_updated_at: at,
  shell_imported_at: at,
  transcript_imported_at: at,
  imported_message_count: 1,
});
insert("styal_legacy_v1_thread_activities", {
  activity_id: "activity-alpha",
  thread_id: "legacy-only",
  turn_id: "turn-alpha",
  tone: "info",
  kind: "tool.started",
  summary: "Synthetic activity",
  payload_json: '{"toolName":"synthetic_tool"}',
  created_at: at,
});
insert("styal_legacy_v1_turns", {
  thread_id: "legacy-only",
  turn_id: "turn-alpha",
  state: "completed",
  requested_at: at,
  checkpoint_files_json: "[]",
});
const message = {
  createdBy: "agent",
  creationSource: "provider",
  id: "message-alpha",
  threadId: "ordinary",
  runId: null,
  nodeId: null,
  role: "assistant",
  text: "Synthetic message ada@example.test",
  attachments: [],
  streaming: false,
  createdAt: at,
  updatedAt: at,
  legacyTurnId: "turn-alpha",
  report: {
    key: "alpha",
    title: "Synthetic report",
    version: 1,
    question: "Synthetic question",
    blocking: true,
  },
  reportAnswer: { messageId: "message-parent", key: "alpha", version: 1 },
};
Schema.decodeUnknownSync(Contracts.OrchestrationV2ConversationMessageJson)(message);
insert("orchestration_v2_projection_messages", {
  message_id: "message-alpha",
  thread_id: "ordinary",
  role: "assistant",
  streaming: 0,
  created_at: at,
  updated_at: at,
  payload_json: JSON.stringify(message),
});
event("ordinary", "message.updated", message, 2);
event(
  "ordinary",
  "message.mentioned-times-checked",
  { messageId: "message-alpha", mentionedTimes: { checkedAt: at, spans: [] } },
  3,
);
const usage = {
  records: [{ turnId: "turn-alpha", usage: null, model: null }],
  thread: {
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    turns: 1,
    countedTurns: 1,
    partialTurns: 0,
    subagentTurns: 0,
  },
};
event("ordinary", "legacy-usage.imported", usage, 4);
insert("styal_projection_legacy_turn_usage", {
  thread_id: "legacy-only",
  payload_json: JSON.stringify(usage),
});
const request = {
  id: "request-alpha",
  nodeId: "node-alpha",
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "server", attention: "input" },
  createdAt: at,
  resolvedAt: null,
};
Schema.decodeUnknownSync(Contracts.OrchestrationV2RuntimeRequestJson)(request);
insert("orchestration_v2_projection_runtime_requests", {
  runtime_request_id: request.id,
  thread_id: "ordinary",
  node_id: request.nodeId,
  kind: request.kind,
  status: request.status,
  created_at: at,
  payload_json: JSON.stringify(request),
});
event("ordinary", "runtime-request.updated", request, 5);
const turn = {
  id: "provider-turn-alpha",
  providerThreadId: "provider-thread-alpha",
  nodeId: "node-alpha",
  runAttemptId: null,
  nativeTurnRef: null,
  nativePromptRef: { driver: "codex", nativeId: "prompt-alpha", strength: "strong" },
  ordinal: 1,
  status: "completed",
  startedAt: at,
  completedAt: at,
  model: "synthetic-model",
  threadTokenUsage: usage.thread,
};
Schema.decodeUnknownSync(Contracts.OrchestrationV2ProviderTurnJson)(turn);
insert("orchestration_v2_projection_provider_turns", {
  provider_turn_id: turn.id,
  thread_id: "ordinary",
  provider_thread_id: turn.providerThreadId,
  node_id: turn.nodeId,
  ordinal: 1,
  status: turn.status,
  payload_json: JSON.stringify(turn),
});
const run = {
  id: "run-alpha",
  threadId: "ordinary",
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  providerThreadId: null,
  userMessageId: "message-alpha",
  rootNodeId: null,
  activeAttemptId: null,
  status: "cancelled",
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  checkpointId: null,
  contextHandoffId: null,
  cancelledByThreadId: "fork",
  restartHeldRunIds: ["run-held"],
};
Schema.decodeUnknownSync(Contracts.OrchestrationV2RunJson)(run);
insert("orchestration_v2_projection_runs", {
  run_id: run.id,
  thread_id: "ordinary",
  ordinal: 1,
  provider: "codex",
  provider_instance_id: "codex",
  status: run.status,
  requested_at: at,
  payload_json: JSON.stringify(run),
});
event("ordinary", "run.updated", run, 6);
const item = {
  id: "item-alpha",
  threadId: "ordinary",
  runId: "run-alpha",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  type: "assistant_message",
  messageId: "message-alpha",
  text: "Synthetic message",
  streaming: false,
  legacyTurnId: "turn-alpha",
  legacyActivities: [
    {
      id: "activity-alpha",
      tone: "info",
      kind: "synthetic",
      summary: "Synthetic activity",
      payload: { synthetic: true },
      turnId: "turn-alpha",
      createdAt: at,
    },
  ],
  report: message.report,
};
Schema.decodeUnknownSync(Contracts.OrchestrationV2TurnItemJson)(item);
insert("orchestration_v2_projection_turn_items", {
  turn_item_id: item.id,
  thread_id: "ordinary",
  run_id: "run-alpha",
  ordinal: 1,
  type: item.type,
  status: item.status,
  updated_at: at,
  payload_json: JSON.stringify(item),
});
event("ordinary", "turn-item.updated", item, 7);

const checkpoint = {
  id: "checkpoint-alpha",
  threadId: "ordinary",
  scopeId: "scope-alpha",
  runId: "run-alpha",
  nodeId: "node-alpha",
  parentCheckpointId: null,
  ordinalWithinScope: 1,
  appRunOrdinal: 1,
  ref: "refs/t3/orchestration-v2/checkpoints/synthetic-alpha",
  status: "ready",
  files: [],
  capturedAt: at,
  legacyTurnId: "turn-alpha",
  assistantMessageId: "message-alpha",
  legacyCheckpointTurnCount: 1,
};
Schema.decodeUnknownSync(Contracts.OrchestrationV2CheckpointJson)(checkpoint);
insert("orchestration_v2_projection_checkpoints", {
  checkpoint_id: checkpoint.id,
  thread_id: "ordinary",
  scope_id: checkpoint.scopeId,
  run_id: "run-alpha",
  node_id: checkpoint.nodeId,
  ordinal_within_scope: 1,
  app_run_ordinal: 1,
  status: checkpoint.status,
  captured_at: at,
  payload_json: JSON.stringify(checkpoint),
});
event("ordinary", "checkpoint.captured", checkpoint, 8);
for (const [id, threadId, version] of [
  ["message-clean", "ordinary", 9],
  ["message-imported", "legacy-imported", 2],
] as const) {
  const clean = {
    ...message,
    id,
    threadId,
    report: undefined,
    reportAnswer: undefined,
    legacyTurnId: undefined,
    text: "Synthetic ordinary message",
  };
  Schema.decodeUnknownSync(Contracts.OrchestrationV2ConversationMessageJson)(clean);
  insert("orchestration_v2_projection_messages", {
    message_id: id,
    thread_id: threadId,
    role: "assistant",
    streaming: 0,
    created_at: at,
    updated_at: at,
    payload_json: JSON.stringify(clean),
  });
  event(threadId, "message.updated", clean, version);
  if (threadId === "legacy-imported")
    insert("projection_thread_messages", {
      message_id: id,
      thread_id: threadId,
      role: "assistant",
      text: clean.text,
      is_streaming: 0,
      created_at: at,
      updated_at: at,
    });
}
const SourceEffects = await import(
  NodeURL.pathToFileURL(NodePath.join(root, "apps/server/src/orchestration-v2/EffectOutbox.ts"))
    .href
);
Schema.decodeUnknownSync(SourceEffects.OrchestrationEffectRequestV2)({
  type: "provider-turn.start",
  runId: "run-alpha",
});
insert("orchestration_v2_effect_outbox", {
  effect_id: "effect-alpha",
  command_id: "command-alpha",
  thread_id: "ordinary",
  effect_type: "provider-turn.start",
  payload_json: JSON.stringify({ type: "provider-turn.start", runId: "run-alpha" }),
  status: "pending",
  available_at: at,
  created_at: at,
  updated_at: at,
});
insert("scheduled_tasks", {
  task_id: "task-alpha",
  title: "Synthetic task",
  prompt: "Synthetic prompt",
  enabled: 1,
  schedule_json: '{"type":"interval","everyMs":60000}',
  project_id: "project-alpha",
  workspace_strategy_json: '{"type":"root"}',
  model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
  runtime_mode: "full-access",
  interaction_mode: "default",
  created_by: "user",
  creation_source: "web",
  created_at: at,
  updated_at: at,
  last_run_status: "never",
  run_count: 0,
});
for (const [id, expires] of [
  ["expired", "2020-01-01T00:00:00.000Z"],
  ["valid", "2099-01-01T00:00:00.000Z"],
])
  insert("auth_sessions", {
    session_id: id!,
    subject: "ada@example.test",
    scopes: "[]",
    method: "browser-session-cookie",
    issued_at: at,
    expires_at: expires!,
  });
insert("peer_environment_links", {
  environment_id: "environment-alpha",
  secret_name: "synthetic-secret",
  label: "Synthetic peer",
  urls_json: '["https://peer.example.test"]',
  access: "full-access",
  linked_at: at,
  expires_at: "2099-01-01T00:00:00.000Z",
});
db.exec(
  "UPDATE orchestration_v2_projection_metadata SET schema_version = 2, last_sequence = (SELECT max(sequence) FROM orchestration_events) WHERE projection_name = 'thread-projections'",
);

db.exec("COMMIT");
const schema = db
  .prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
  )
  .all();
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keys = new Set<string>();
for (const value of Object.values(Contracts)) {
  if (value && (typeof value === "object" || typeof value === "function") && "ast" in value)
    schemaKeys(value.ast, keys);
}
const optional = new NodeSqlite.DatabaseSync(":memory:");
for (const sql of Object.values(objects.optionalTables)) optional.exec(sql);
const optionalDefinitions = optional
  .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL")
  .all();
const description = {
  pin: "68e0ea592ac9a2262d04f2457d83e3f21d73ac73",
  ledger: db
    .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
    .all(),
  forkLedger: db
    .prepare("SELECT migration_id, name FROM yngatech_sql_migrations ORDER BY migration_id")
    .all(),
  definitions: [...schema, ...optionalDefinitions]
    .map((entry) => {
      const name = String(entry.name);
      const installed = objects.installedHistory[name as keyof typeof objects.installedHistory];
      const variants = [];
      if (installed) {
        const variant = new NodeSqlite.DatabaseSync(":memory:");
        variant.exec(installed);
        const variantColumns = variant.prepare(`PRAGMA table_xinfo("${name}")`).all();
        const baseColumns = db.prepare(`PRAGMA table_xinfo("${name}")`).all();
        const byName = (columns: typeof baseColumns) =>
          columns
            .map(({ cid: _cid, ...column }) => column)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (JSON.stringify(byName(variantColumns)) !== JSON.stringify(byName(baseColumns)))
          throw new Error("Installed-history variant changes column definitions");
        variants.push({
          label: "installed-history",
          hash: hash(installed),
          columns: variantColumns,
        });
        variant.close();
      }
      return {
        type: entry.type,
        name: entry.name,
        table: entry.tbl_name,
        hash: hash(entry.sql),
        columns:
          entry.type === "table"
            ? (Object.hasOwn(objects.optionalTables, name) ? optional : db)
                .prepare(`PRAGMA table_xinfo("${name}")`)
                .all()
            : [],
        ...(variants.length ? { variants } : {}),
        ...(Object.hasOwn(objects.optionalTables, name) || objects.optionalTriggers.includes(name)
          ? { optional: true }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        String(a.type).localeCompare(String(b.type)) ||
        String(a.name).localeCompare(String(b.name)),
    ),
  keys: [...keys].sort(),
  settings: Object.keys(Contracts.ServerSettings.fields).sort(),
};
NodeFS.writeFileSync(
  NodePath.join(output, "source.json"),
  JSON.stringify(description, null, 2) + "\n",
);
NodeFS.writeFileSync(
  NodePath.join(output, "source.sqlite.gz"),
  NodeZlib.gzipSync(NodeFS.readFileSync(filename), { level: 9 }),
);
optional.close();
db.close();
NodeFS.unlinkSync(filename);
