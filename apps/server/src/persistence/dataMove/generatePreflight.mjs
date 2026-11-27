import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
await import("./generateSource.ts");
const root = NodeFS.realpathSync(process.argv[2]);
const output = NodeFS.realpathSync(process.argv[3]);
const require = NodeModule.createRequire(root + "/apps/server/package.json");
const S = await import(NodeURL.pathToFileURL(require.resolve("effect/Schema")).href);
const C = await import(NodeURL.pathToFileURL(root + "/packages/contracts/src/index.ts").href);
const file = output + "/source.sqlite";
NodeFS.writeFileSync(file, NodeZlib.gunzipSync(NodeFS.readFileSync(output + "/source.sqlite.gz")));
const db = new NodeSqlite.DatabaseSync(file);
const desc = JSON.parse(NodeFS.readFileSync(new URL("./source.json", import.meta.url), "utf8"));
const at = "2026-01-01T00:00:00.000Z";
const codecNames = {
  threads: "AppThread",
  runs: "Run",
  run_attempts: "RunAttempt",
  nodes: "ExecutionNode",
  provider_threads: "ProviderThread",
  messages: "ConversationMessage",
  provider_sessions: "ProviderSession",
  context_transfers: "ContextTransfer",
  plans: "PlanArtifact",
  checkpoint_scopes: "CheckpointScope",
  context_handoffs: "ContextHandoff",
  subagents: "Subagent",
};
function insert(table, row) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${keys.map((k) => '"' + k + '"').join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
  ).run(...Object.values(row));
}
function projection(kind, p) {
  S.decodeUnknownSync(
    C["OrchestrationV2" + codecNames[kind] + "Json"] ?? C["OrchestrationV2" + codecNames[kind]],
  )(p);
  const table = "orchestration_v2_projection_" + kind;
  const cols = desc.definitions.find((d) => d.name === table).columns;
  const row = {};
  for (const col of cols) {
    const camel = col.name.replace(/_([a-z])/g, (_, s) => s.toUpperCase());
    let v = col.pk
      ? p.id
      : col.name === "thread_id"
        ? (p.threadId ?? p.appThreadId ?? "ordinary")
        : col.name === "payload_json"
          ? JSON.stringify(p)
          : col.name === "provider"
            ? "codex"
            : p[camel];
    if (typeof v === "boolean") v = Number(v);
    if (v === undefined) {
      if (!col.notnull) v = null;
      else if (col.dflt_value !== null) continue;
      else v = col.type === "INTEGER" ? 1 : "synthetic";
    }
    row[col.name] = v;
  }
  insert(table, row);
}
function event(type, p, version, threadId = "ordinary") {
  S.decodeUnknownSync(C.OrchestrationV2DomainEventJson)({
    id: "extra-" + version,
    threadId,
    type,
    payload: p,
    occurredAt: at,
  });
  insert("orchestration_events", {
    event_id: "extra-" + version,
    aggregate_kind: "thread",
    stream_id: threadId,
    stream_version: version,
    event_type: type,
    occurred_at: at,
    actor_kind: "server",
    payload_json: JSON.stringify(p),
    metadata_json: "{}",
    application_event_version: 2,
  });
  return Number(db.prepare("SELECT max(sequence) n FROM orchestration_events").get().n);
}
db.exec("BEGIN");
db.exec(
  "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.options',json('[]')) WHERE thread_id='model-options-string'",
);
const ordinary = JSON.parse(
  db
    .prepare(
      "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='ordinary'",
    )
    .get().payload_json,
);
projection("threads", {
  ...ordinary,
  id: "synthetic-child",
  lineage: {
    parentThreadId: "ordinary",
    relationshipToParent: "subagent",
    rootThreadId: "ordinary",
  },
});
const subagent = {
  id: "synthetic-subagent",
  threadId: "ordinary",
  runId: null,
  parentNodeId: "node-alpha",
  origin: "provider_native",
  createdBy: "agent",
  driver: "codex",
  providerInstanceId: "codex",
  providerThreadId: null,
  childThreadId: "synthetic-child",
  nativeTaskRef: { driver: "codex", nativeId: "synthetic-task", strength: "strong" },
  prompt: "SYNTHETIC_PROMPT_NEVER_PRINT",
  title: "Synthetic subagent",
  model: null,
  status: "running",
  result: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
};
projection("subagents", subagent);
const anchor = event("subagent.updated", subagent, 100);
const compact = event("subagent.updated", subagent, 101);
db.prepare(
  "UPDATE orchestration_events SET payload_json=json_set(payload_json,'$.prompt','','$.promptSequence',CAST(? AS INTEGER)) WHERE sequence=?",
).run(anchor, compact);
projection("provider_threads", {
  id: "synthetic-provider-thread",
  driver: "codex",
  providerInstanceId: "codex",
  providerSessionId: null,
  appThreadId: "ordinary",
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [
    {
      kind: "command",
      taskId: "synthetic-background",
      command: {
        nativeItemId: "synthetic-item",
        turnItemId: "synthetic-item",
        nodeId: "node-alpha",
        threadId: "ordinary",
        runId: null,
        rootNodeId: "node-alpha",
        parentNodeId: "node-alpha",
        providerThreadId: null,
        providerTurnId: null,
        ordinal: 0,
        input: "SYNTHETIC_COMMAND_NEVER_PRINT",
        startedAt: at,
      },
    },
  ],
  createdAt: at,
  updatedAt: at,
});
projection("context_handoffs", {
  id: "synthetic-handoff",
  threadId: "ordinary",
  targetRunId: "run-alpha",
  fromProviderThreadIds: [],
  toProviderThreadId: "synthetic-provider-thread",
  coveredRunOrdinals: { from: 1, to: 1 },
  strategy: "manual_context",
  status: "pending",
  summaryMessageId: null,
  summaryText: "SYNTHETIC_HANDOFF_NEVER_PRINT",
  createdByProviderInstanceId: null,
  createdAt: at,
  updatedAt: at,
});
projection("nodes", {
  id: "synthetic-node",
  threadId: "ordinary",
  runId: "run-alpha",
  parentNodeId: null,
  rootNodeId: "synthetic-node",
  kind: "root_turn",
  status: "running",
  countsForRun: true,
  providerThreadId: "synthetic-provider-thread",
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: at,
  completedAt: null,
});
projection("run_attempts", {
  id: "synthetic-attempt",
  runId: "run-alpha",
  attemptOrdinal: 1,
  rootNodeId: "synthetic-node",
  providerInstanceId: "codex",
  providerThreadId: "synthetic-provider-thread",
  providerTurnId: null,
  reason: "initial",
  status: "running",
  startedAt: at,
  completedAt: null,
});
// Capability schemas contain only objects, booleans, literals and nullable numbers.
function capability(ast) {
  if (ast._tag === "Objects")
    return Object.fromEntries(
      ast.propertySignatures
        .filter((p) => !p.type.context?.isOptional)
        .map((p) => [p.name, capability(p.type)]),
    );
  if (ast._tag === "Union")
    return capability(ast.types.find((t) => t._tag === "Null") ?? ast.types[0]);
  if (ast._tag === "Literal") return ast.literal;
  if (ast._tag === "Boolean") return false;
  if (ast._tag === "Null") return null;
  throw new Error("Unsupported synthetic capability shape");
}
projection("provider_sessions", {
  id: "synthetic-session",
  driver: "codex",
  providerInstanceId: "codex",
  status: "ready",
  cwd: "/synthetic/project-alpha",
  model: null,
  capabilities: capability(C.OrchestrationV2ProviderCapabilities.ast),
  createdAt: at,
  updatedAt: at,
  lastError: null,
});
insert("orchestration_v2_projection_provider_session_bindings", {
  provider_session_id: "synthetic-session",
  thread_id: "ordinary",
});
projection("context_transfers", {
  id: "synthetic-transfer",
  type: "provider_handoff",
  sourceThreadId: "ordinary",
  targetThreadId: "synthetic-child",
  sourcePoint: { threadId: "ordinary" },
  basePoint: null,
  sourceProviderInstanceId: null,
  targetProviderInstanceId: null,
  targetRunId: null,
  status: "pending",
  resolution: null,
  createdBy: "user",
  error: null,
  createdAt: at,
  updatedAt: at,
  consumedAt: null,
});
projection("checkpoint_scopes", {
  id: "scope-alpha",
  threadId: "ordinary",
  runId: "run-alpha",
  nodeId: "node-alpha",
  parentScopeId: null,
  providerThreadId: null,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd: "/synthetic/project-alpha",
  createdAt: at,
});
projection("plans", {
  id: "synthetic-plan",
  threadId: "ordinary",
  runId: "run-alpha",
  nodeId: "node-alpha",
  status: "draft",
  kind: "todo_list",
  steps: [],
});
function json(codec, value) {
  S.decodeUnknownSync(codec)(value);
  return JSON.stringify(value);
}
const modelSelection = { instanceId: "codex", model: "gpt-5" };
const linked = {
  projectId: "project-alpha",
  repository: "example/synthetic",
  number: 1,
  url: "https://example.test/synthetic/pull/1",
};
db.prepare("UPDATE projection_projects SET default_model_selection_json=?,project_icon_json=?").run(
  json(C.ModelSelection, modelSelection),
  json(C.StoredProjectIcon, { kind: "monogram", text: "S", color: "gray" }),
);
db.prepare(
  "UPDATE projection_threads SET model_selection_json=?,linked_pull_request_json=?,branch_pull_request_json=?",
).run(
  json(C.ModelSelection, modelSelection),
  json(C.ThreadLinkedPullRequest, linked),
  json(C.ThreadLinkedPullRequest, linked),
);
db.prepare("UPDATE projection_thread_messages SET attachments_json=?,context_json=?").run(
  json(S.Array(C.ChatAttachment), []),
  json(C.OrchestrationMessageContext, { version: 1, records: [] }),
);
insert("projection_thread_pull_requests", {
  thread_id: "ordinary",
  host: "example.test",
  repository: "example/synthetic",
  number: 1,
  url: linked.url,
  source: "manual",
  linked_at: at,
  snapshot_json: json(C.ThreadPullRequestSnapshot, {
    state: "open",
    title: "Synthetic review",
    headBranch: "synthetic-change",
    baseBranch: "main",
    isDraft: false,
    updatedAt: at,
    syncedAt: at,
  }),
  stack_json: json(C.ThreadPullRequestStack, {
    kind: "native",
    id: "synthetic-stack",
    number: 1,
    url: linked.url,
    base: "main",
    layers: [],
  }),
});
insert("pull_request_review_guides", {
  host: "example.test",
  repository: "example/synthetic",
  number: 1,
  guide_json: json(C.PullRequestReviewGuide, {
    headSha: "synthetic-head",
    generatedAt: at,
    modelSelection,
    stops: [],
  }),
});
const run = JSON.parse(
  db
    .prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id='run-alpha'")
    .get().payload_json,
);
const finishedThread = {
  ...ordinary,
  id: "synthetic-finished",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "synthetic-finished" },
};
projection("threads", finishedThread);
const finishedMessage = {
  ...JSON.parse(
    db
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id='message-clean'",
      )
      .get().payload_json,
  ),
  id: "synthetic-finished-message",
  threadId: "synthetic-finished",
  createdBy: "user",
  creationSource: "web",
  role: "user",
  text: "SYNTHETIC_FINISHED_NEVER_PRINT",
};
projection("messages", finishedMessage);
const finishedRun = {
  ...run,
  id: "synthetic-finished-run",
  threadId: "synthetic-finished",
  userMessageId: "synthetic-finished-message",
  status: "completed",
  completedAt: at,
  cancelledByThreadId: undefined,
  restartHeldRunIds: undefined,
};
projection("runs", finishedRun);
event("thread.created", finishedThread, 1, "synthetic-finished");
event("message.updated", finishedMessage, 2, "synthetic-finished");
event("run.updated", finishedRun, 3, "synthetic-finished");
run.status = "running";
run.completedAt = null;
db.prepare(
  "UPDATE orchestration_v2_projection_runs SET status='running',payload_json=? WHERE run_id='run-alpha'",
).run(JSON.stringify(run));
const historicalUsage = {
  usageScope: "main_agent",
  usageStatus: "complete",
  hasSubagents: true,
  inputTokens: 1,
  outputTokens: 2,
  subagents: { inputTokens: 1, outputTokens: 1 },
  byModel: [{ inputTokens: 1, outputTokens: 2 }],
  costUsd: 0,
};
const turn = JSON.parse(
  db.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_turns LIMIT 1").get()
    .payload_json,
);
turn.turnTokenUsage = historicalUsage;
S.decodeUnknownSync(C.OrchestrationV2ProviderTurnJson)(turn);
db.prepare("UPDATE orchestration_v2_projection_provider_turns SET payload_json=?").run(
  JSON.stringify(turn),
);
const script = {
  id: "synthetic-script",
  name: "Synthetic script",
  command: "SYNTHETIC_SCRIPT_NEVER_PRINT",
  icon: "desktop",
  runOnWorktreeCreate: false,
};
S.decodeUnknownSync(C.ProjectScript)(script);
insert("orchestration_events", {
  event_id: "synthetic-project-event",
  aggregate_kind: "project",
  stream_id: "project-alpha",
  stream_version: 1,
  event_type: "project.meta-updated",
  occurred_at: at,
  actor_kind: "server",
  payload_json: JSON.stringify({ projectId: "project-alpha", scripts: [script], updatedAt: at }),
  metadata_json: "{}",
  application_event_version: 2,
});
db.exec(
  "UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT max(sequence) FROM orchestration_events) WHERE projection_name='thread-projections'",
);
db.exec("COMMIT");
db.close();
NodeFS.writeFileSync(
  output + "/preflight.sqlite.gz",
  NodeZlib.gzipSync(NodeFS.readFileSync(file), { level: 9 }),
);

NodeFS.unlinkSync(file);

// Derive the installed-history family from the same synthetic preflight records.
const { installHistoryVariant } = await import("./installedHistoryFixture.ts");
const installedFile = output + "/installed-history.sqlite";
NodeFS.writeFileSync(
  installedFile,
  NodeZlib.gunzipSync(NodeFS.readFileSync(output + "/preflight.sqlite.gz")),
);
const installed = new NodeSqlite.DatabaseSync(installedFile);
installHistoryVariant(installed);
installed.close();
NodeFS.writeFileSync(
  output + "/installed-history.sqlite.gz",
  NodeZlib.gzipSync(NodeFS.readFileSync(installedFile), { level: 9 }),
);
NodeFS.unlinkSync(installedFile);
