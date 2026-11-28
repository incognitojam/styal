// @effect-diagnostics nodeBuiltinImport:off - Offline SQLite maintenance boundary.
// @effect-diagnostics globalJsonInEffect:off - Archived source JSON is changed without normalizing unrelated fields.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Contracts from "@t3tools/contracts";
import { OrchestrationEffectRequestV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { historicalEffectTypes } from "../historical.ts";
import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import {
  delegatedTaskRuns,
  delegatedTaskResultRun,
} from "../../orchestration-v2/RestartBackgroundNote.ts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { archive } from "./archive.ts";
import { assertOffline, PreflightRefusal } from "./preflight.ts";
import source from "./source.json" with { type: "json" };
import { compareSchema, schemaHash } from "./schema.ts";

const stateTable = "styal_neutralisation";
const stateDefinition = `CREATE TABLE ${stateTable} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_version INTEGER NOT NULL CHECK (format_version = 2),
  mode TEXT NOT NULL CHECK (mode IN ('cutover','rehearsal')),
  completed_at TEXT NOT NULL,
  impact_json TEXT NOT NULL
)`;
const refuse = (category: string) => new PreflightRefusal({ category });
const isRefusal = Schema.is(PreflightRefusal);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const databaseFailure = (error: unknown) => {
  if (isRefusal(error)) return error;
  const code = object(error) ? Number(error.errcode) : undefined;
  return refuse(
    code === 5 || code === 6
      ? "database-busy"
      : code === 11 || code === 26
        ? "database-invalid"
        : "neutralisation-failed",
  );
};
const active = new Set(["pending", "preparing", "queued", "starting", "running", "waiting"]);
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Mode = "cutover" | "rehearsal";
type Counts = Record<string, number>;
type Payload = Record<string, unknown>;
const decodeEvent = Schema.decodeUnknownSync(Contracts.OrchestrationV2DomainEventJson);
const decodeEffect = Schema.decodeUnknownSync(OrchestrationEffectRequestV2);
const decodeSchedule = Schema.decodeUnknownSync(Contracts.ScheduledTaskSchedule);
const decodeMessage = Schema.decodeUnknownSync(Contracts.OrchestrationV2ConversationMessageJson);
const decodeRun = Schema.decodeUnknownSync(Contracts.OrchestrationV2RunJson);

const projectionEvents = {
  runs: "run.updated",
  run_attempts: "run-attempt.updated",
  nodes: "node.updated",
  provider_turns: "provider-turn.updated",
  runtime_requests: "runtime-request.updated",
  provider_threads: "provider-thread.updated",
  provider_sessions: "provider-session.updated",
  subagents: "subagent.updated",
  messages: "message.updated",
  turn_items: "turn-item.updated",
  context_handoffs: "context-handoff.updated",
  context_transfers: "context-transfer.updated",
  threads: "thread.metadata-updated",
} as const;

const scalarRules = (mode: Mode, now: string) => [
  {
    table: "scheduled_tasks",
    kind: "interrupted-runs / failed",
    where: "last_run_status='running'",
    set: "last_run_status='failed',last_run_error='Run was interrupted by a server restart.',updated_at=?",
    values: [now],
  },
  {
    table: "scheduled_task_webhook_deliveries",
    kind: "webhook-deliveries / dispatch_failed",
    where:
      "delivery_id IN (SELECT delivery_id FROM scheduled_task_webhook_pending WHERE state IN ('pending','dispatching','running')) AND outcome IN ('accepted','coalesced')",
    set: "outcome='dispatch_failed',error='Interrupted by offline data move.'",
    values: [],
  },
  {
    table: "scheduled_task_webhook_pending",
    kind: mode === "rehearsal" ? "webhook-dispatch / removed" : "webhook-dispatch / failed",
    where: mode === "rehearsal" ? "1" : "state IN ('pending','dispatching','running')",
    set: mode === "rehearsal" ? null : "state='failed'",
    values: [],
  },
  {
    table: "orchestration_v2_effect_outbox",
    kind: "effects / cancelled",
    where: "status IN ('pending','running')",
    set: `status='cancelled',lease_owner=NULL,lease_expires_at=NULL,completed_at=?,updated_at=?,last_error='Interrupted by offline data move.'`,
    values: [now, now],
  },
  ...(mode === "rehearsal"
    ? [
        {
          table: "scheduled_tasks",
          kind: "schedules / disabled",
          where:
            "enabled<>0 OR next_run_at IS NOT NULL OR webhook_token IS NOT NULL OR webhook_secret IS NOT NULL",
          set: "enabled=0,next_run_at=NULL,webhook_token=NULL,webhook_secret=NULL",
          values: [],
        },
        {
          table: "scheduled_task_webhook_deliveries",
          kind: "webhook-headers / cleared",
          where: "headers_json<>'{}'",
          set: "headers_json='{}'",
          values: [],
        },
        {
          table: "hardware_leases",
          kind: "lease-tokens / cleared",
          where: "token<>''",
          set: "token=''",
          values: [],
        },
        {
          table: "projection_thread_sessions",
          kind: "native-session-refs / cleared",
          where:
            "provider_session_id IS NOT NULL OR provider_thread_id IS NOT NULL OR active_turn_id IS NOT NULL",
          set: "provider_session_id=NULL,provider_thread_id=NULL,active_turn_id=NULL",
          values: [],
        },
        ...[
          "auth_sessions",
          "auth_pairing_links",
          "peer_environment_links",
          "provider_session_runtime",
        ].map((table) => ({
          table,
          kind: "credentials / removed",
          where: "1",
          set: null,
          values: [],
        })),
      ]
    : []),
];

function interruptedSchedules(db: NodeSqlite.DatabaseSync, now: DateTime.DateTime) {
  return db
    .prepare(
      `SELECT rowid AS row_id,*,EXISTS(SELECT 1 FROM scheduled_task_webhook_pending pending WHERE pending.task_id IS scheduled_tasks.task_id AND pending.state='running' AND pending.delivery_id=scheduled_tasks.last_run_webhook_delivery_id) AS counted FROM scheduled_tasks WHERE last_run_status='running'`,
    )
    .all()
    .map((row) => {
      let schedule: Contracts.ScheduledTaskSchedule;
      try {
        schedule = decodeSchedule(JSON.parse(String(row.schedule_json)));
      } catch {
        throw refuse("schedule-undecodable");
      }
      const from =
        schedule.type === "once" && typeof row.last_run_at === "string"
          ? Option.getOrElse(DateTime.make(row.last_run_at), () => now)
          : now;
      let nextRunAt: string | null = null;
      if (row.enabled === 1) {
        try {
          const next = nextScheduledRunAt(schedule, from);
          if (next !== null && Number.isFinite(DateTime.toEpochMillis(next)))
            nextRunAt = DateTime.formatIso(next);
        } catch {
          /* Match the runtime's unrepresentable-schedule fallback. */
        }
      }
      return { rowid: Number(row.row_id), nextRunAt, countDelta: row.counted ? 0 : 1 };
    });
}

function copyWork(db: NodeSqlite.DatabaseSync) {
  const runs = db
    .prepare("SELECT payload_json FROM orchestration_v2_projection_runs")
    .all()
    .map((row) => readPayload(row.payload_json));
  const held = new Set<string>();
  for (const run of runs) {
    if (run.status !== "queued") continue;
    const row = db
      .prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?")
      .get(String(run.userMessageId));
    if (!row) throw refuse("queued-message-missing");
    const message = readPayload(row.payload_json);
    try {
      decodeMessage(message);
    } catch {
      throw refuse("queued-message-undecodable");
    }
    if (
      message.createdBy === "user" &&
      message.scheduledTaskId === undefined &&
      message.notification === undefined &&
      message.delegatedCompletion === undefined
    )
      held.add(String(run.id));
  }
  return {
    held,
    live: new Set(
      runs
        .filter((run) => active.has(String(run.status)) && !held.has(String(run.id)))
        .map((run) => String(run.id)),
    ),
  };
}

function readPayload(value: unknown): Payload {
  try {
    const payload: unknown = JSON.parse(String(value));
    if (object(payload)) return payload;
  } catch {
    /* Refuse with a fixed category below. */
  }
  throw refuse("projection-payload-invalid");
}

function settle(
  kind: keyof typeof projectionEvents,
  original: Payload,
  mode: Mode,
  now: string,
  work: ReturnType<typeof copyWork>,
) {
  const p = { ...original };
  const wasActive =
    active.has(String(original.status)) || (kind === "subagents" && original.status === "idle");
  const held = kind === "runs" ? work.held.has(String(p.id)) : work.held.has(String(p.runId));
  const pendingDelivery =
    object(p.completionDelivery) &&
    ["pending", "claimed"].includes(String(p.completionDelivery.state));
  const heldRecord =
    held &&
    (kind === "runs" ||
      kind === "run_attempts" ||
      kind === "nodes" ||
      (kind === "turn_items" && p.type === "user_message"));
  if (
    ["runs", "run_attempts", "nodes", "provider_turns", "subagents", "turn_items"].includes(kind)
  ) {
    if (typeof p.status === "string" && wasActive && !heldRecord) {
      p.status = "cancelled";
      p.completedAt = now;
      if (kind === "runs") {
        p.queuePosition = null;
        delete p.queueHeld;
        delete p.steerWhenReadyRunId;
        delete p.restartContinuationOfRunId;
      }
      if (kind === "turn_items") {
        if ("streaming" in p) p.streaming = false;
        if (p.secretStatus === "pending") p.secretStatus = "cancelled";
      }
    }
  }
  if (heldRecord) {
    if (kind === "runs") p.queueHeld = true;
    if ((kind === "run_attempts" || kind === "nodes") && wasActive) {
      p.status = "pending";
      p.startedAt = null;
      p.completedAt = null;
    }
    if (kind === "turn_items" && p.type === "user_message" && wasActive) {
      p.status = "pending";
      p.inputIntent = "queued_turn";
      p.startedAt = null;
      p.completedAt = null;
    }
  }
  if (
    kind === "runs" &&
    object(p.delegatedCompletion) &&
    (wasActive ||
      (p.delegatedCompletion.disposition === "open" && object(p.delegatedCompletion.delivery)))
  )
    p.delegatedCompletion = {
      ...p.delegatedCompletion,
      disposition: p.delegatedCompletion.disposition === "disposed" ? "disposed" : "stopped",
      delivery: null,
    };
  if (kind === "subagents") {
    if (
      p.origin === "app_owned" &&
      (wasActive ||
        pendingDelivery ||
        (object(p.remoteChild) &&
          p.remoteChild.stoppedThere !== true &&
          p.result === null &&
          !object(p.completionDelivery)))
    )
      p.completionDelivery = { state: "disposed", observedByRunId: null };
    if (p.origin === "app_owned" && p.result === null && wasActive) {
      p.result =
        "Automatic reporting stopped during the offline data move. Read the task's original thread for its history.";
      p.completionDelivery = { state: "disposed", observedByRunId: null };
    }
  }
  if (kind === "runtime_requests" && p.status === "pending") {
    p.status = "expired";
    p.resolvedAt = now;
    p.responseCapability = {
      type: "not_resumable",
      reason: "The server restarted before this runtime request was resolved.",
    };
  }
  if (kind === "provider_threads") {
    if (p.status === "active") p.status = "idle";
    if (Array.isArray(p.pendingBackgroundTasks) && p.pendingBackgroundTasks.length)
      p.pendingBackgroundTasks = [];
    if (mode === "rehearsal") {
      p.nativeThreadRef = null;
      p.nativeConversationHeadRef = null;
      p.providerSessionId = null;
      p.forkedFrom = null;
      p.nativeMetadata = null;
    }
  }
  if (
    kind === "provider_sessions" &&
    ((p.status !== "stopped" && p.status !== "error") ||
      (Array.isArray(p.extensionStatuses) && p.extensionStatuses.length > 0))
  ) {
    if (p.status !== "stopped" && p.status !== "error") p.status = "stopped";
    if (p.status !== "error") p.lastError = null;
    if (Array.isArray(p.extensionStatuses) && p.extensionStatuses.length) p.extensionStatuses = [];
    delete p.startupPhase;
    delete p.startupPhaseThreadId;
  }
  if (kind === "messages" && p.streaming === true) p.streaming = false;
  if (kind === "turn_items" && p.streaming === true) p.streaming = false;
  if (kind === "turn_items" && (wasActive || work.live.has(String(p.runId))) && !heldRecord) {
    for (const field of ["secretStatus", "linkStatus", "feedbackStatus"])
      if (p[field] === "pending") p[field] = "cancelled";
  }
  if (
    kind === "context_handoffs" &&
    (work.live.has(String(p.targetRunId)) ||
      (object(p.delivery) && p.delivery.status === "pending"))
  ) {
    if (p.status === "pending") p.status = "failed";
    if (object(p.delivery) && p.delivery.status === "pending") delete p.delivery;
  }
  if (
    kind === "context_transfers" &&
    p.status === "pending" &&
    work.live.has(String(p.targetRunId))
  ) {
    p.status = "failed";
    p.error = "Interrupted by offline data move.";
  }
  if (
    kind === "context_transfers" &&
    mode === "rehearsal" &&
    object(p.resolution) &&
    p.resolution.strategy === "native_fork"
  ) {
    p.status = "superseded";
    p.resolution = null;
  }
  if (kind === "threads") {
    if (Array.isArray(p.pullRequests))
      p.pullRequests = p.pullRequests.map((link: unknown) => {
        if (!object(link) || !object(link.watch)) return link;
        const { watch, ...rest } = link;
        return { ...rest, endedWatch: watch };
      });
    if (
      mode === "rehearsal" &&
      object(p.guestShare) &&
      typeof p.guestShare.expiresAt === "string" &&
      Date.parse(p.guestShare.expiresAt) > Date.parse(now)
    )
      p.guestShare = { ...p.guestShare, expiresAt: now };
    if (object(p.limitRecovery) && p.limitRecovery.autoResume === true)
      p.limitRecovery = { ...p.limitRecovery, autoResume: false };
    if (p.titleRegeneration != null) p.titleRegeneration = null;
    delete p.rollbackRequestId;
  }
  if (mode === "rehearsal") {
    if (kind === "run_attempts") delete p.nativeThreadId;
    if (kind === "provider_turns") {
      delete p.nativeThreadRef;
      p.nativeTurnRef = null;
    }
    for (const field of ["nativeItemRef", "nativeRequestRef", "nativeTaskRef"])
      if (Object.hasOwn(p, field)) p[field] = null;
    if (kind === "context_handoffs" && object(p.delivery)) delete p.delivery;
    if (kind === "context_transfers") {
      for (const field of ["sourcePoint", "basePoint"]) {
        const point = p[field];
        if (!object(point)) continue;
        const { providerThreadRef: _thread, providerTurnRef: _turn, ...rest } = point;
        p[field] = rest;
      }
    }
  }
  if (JSON.stringify(p) !== JSON.stringify(original) && "updatedAt" in p) p.updatedAt = now;
  return p;
}

function interruptedLimitRecovery(
  db: NodeSqlite.DatabaseSync,
  threadId: string,
  now: string,
  held: ReadonlySet<string>,
) {
  const row = db
    .prepare(`SELECT run.run_id, json_extract(error.payload_json,'$.failure.resetAt') AS reset_at
    FROM orchestration_v2_projection_runs run
    JOIN orchestration_v2_projection_turn_items error ON error.turn_item_id=(
      SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items item
      WHERE item.thread_id=run.thread_id AND item.run_id=run.run_id AND item.type='error' AND item.status='failed'
        AND item.node_id IS json_extract(run.payload_json,'$.rootNodeId')
      ORDER BY item.updated_at DESC,item.ordinal DESC,item.turn_item_id DESC LIMIT 1)
    WHERE run.run_id=(SELECT latest.run_id FROM (
      SELECT *, CASE WHEN status IN ('preparing','queued','starting','running','waiting') AND run_id NOT IN (SELECT value FROM json_each(?)) THEN ? ELSE completed_at END AS effective_completed_at,
        CASE WHEN status IN ('preparing','queued','starting','running','waiting') AND run_id NOT IN (SELECT value FROM json_each(?)) THEN 'cancelled' ELSE status END AS effective_status
      FROM orchestration_v2_projection_runs WHERE thread_id=?
    ) latest WHERE NOT (latest.effective_status='cancelled' AND json_extract(latest.payload_json,'$.startedAt') IS NULL)
      ORDER BY effective_completed_at IS NULL DESC,effective_completed_at DESC,ordinal DESC,run_id DESC LIMIT 1)
      AND run.status='failed' AND json_extract(error.payload_json,'$.failure.class')='usage_limit'
    ORDER BY error.updated_at DESC,error.ordinal DESC,error.turn_item_id DESC LIMIT 1`)
    .get(JSON.stringify([...held]), now, JSON.stringify([...held]), threadId);
  return typeof row?.run_id === "string" && typeof row.reset_at === "string"
    ? { runId: row.run_id, resetAt: row.reset_at, autoResume: false, snooze: false }
    : undefined;
}

export function neutralisationMarker(db: NodeSqlite.DatabaseSync) {
  const definitions = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name=?").all(stateTable);
  if (!definitions.length) return undefined;
  if (definitions.length !== 1 || definitions[0]!.sql !== stateDefinition)
    throw refuse("neutralisation-marker-invalid");
  const rows = db.prepare(`SELECT * FROM ${stateTable}`).all();
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.singleton !== 1 ||
    row?.format_version !== 2 ||
    !Number.isFinite(Date.parse(String(row.completed_at))) ||
    !["cutover", "rehearsal"].includes(String(row.mode))
  )
    throw refuse("neutralisation-marker-invalid");
  let impact: Payload;
  try {
    impact = readPayload(row.impact_json);
  } catch {
    throw refuse("neutralisation-marker-invalid");
  }
  if (
    Object.keys(impact).length !== impactKinds.length ||
    Object.keys(impact).some(
      (key) =>
        !impactKinds.includes(key) || !Number.isSafeInteger(impact[key]) || Number(impact[key]) < 0,
    )
  )
    throw refuse("neutralisation-marker-invalid");
  return { mode: row.mode, impact };
}

export function requireSourceSchema(db: NodeSqlite.DatabaseSync) {
  const definitions = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name",
    )
    .all()
    .filter(
      (row) =>
        ![stateTable, "styal_archive_raw_cells", "styal_archive_raw_manifest"].includes(
          String(row.tbl_name),
        ),
    );
  if (
    Object.keys(
      compareSchema(
        definitions.map((row) => ({
          type: String(row.type),
          name: String(row.name),
          table: String(row.tbl_name),
          hash: schemaHash(row.sql),
        })),
        source.definitions,
      ),
    ).length
  )
    throw refuse("source-schema-required");
  for (const [table, expected] of [
    ["effect_sql_migrations", source.ledger],
    ["yngatech_sql_migrations", source.forkLedger],
  ] as const)
    if (
      JSON.stringify(
        db.prepare(`SELECT migration_id,name FROM ${table} ORDER BY migration_id`).all(),
      ) !== JSON.stringify(expected)
    )
      throw refuse("source-ledgers-required");
}

function projectionPlan(db: NodeSqlite.DatabaseSync, mode: Mode, now: string) {
  const work = copyWork(db);
  const updates: {
    kind: keyof typeof projectionEvents;
    rowid: number;
    threadId: string;
    before: Payload;
    after: Payload;
  }[] = [];
  for (const kind of Object.keys(projectionEvents) as (keyof typeof projectionEvents)[]) {
    const table = `orchestration_v2_projection_${kind}`;
    const primary = source.definitions
      .find((d) => d.name === table)!
      .columns.find((c) => c.pk)!.name;
    for (const row of db.prepare(`SELECT rowid, * FROM ${table}`).iterate()) {
      const before = readPayload(row.payload_json);
      if (before.id !== row[primary]) throw refuse("column-payload-id-mismatch");
      const payloadThreadId = before.threadId ?? before.appThreadId ?? before.sourceThreadId;
      if (
        typeof payloadThreadId === "string" &&
        payloadThreadId !== (row.thread_id ?? row.source_thread_id)
      )
        throw refuse("column-payload-thread-mismatch");
      if (kind === "messages" && before.streaming !== Boolean(row.streaming))
        throw refuse("column-payload-streaming-mismatch");
      const after = settle(kind, before, mode, now, work);
      if (kind === "threads") {
        const recovery = interruptedLimitRecovery(db, String(before.id), now, work.held);
        if (recovery) {
          after.limitRecovery = {
            ...(object(before.limitRecovery) ? before.limitRecovery : {}),
            ...recovery,
          };
          if (JSON.stringify(after.limitRecovery) !== JSON.stringify(before.limitRecovery))
            after.updatedAt = now;
        }
      }
      if ("status" in row && row.status !== before.status)
        throw refuse("column-payload-status-mismatch");
      const restoresOwner =
        kind === "threads" &&
        updates.some(
          (update) => update.kind === "provider_threads" && update.after.appThreadId === before.id,
        );
      if (restoresOwner) after.updatedAt = now;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const threadId = row.thread_id ?? row.source_thread_id;
        if (typeof threadId !== "string") throw refuse("projection-thread-reference-required");
        updates.push({
          kind,
          rowid: Number(row.rowid),
          threadId,
          before,
          after,
        });
      } else if (restoresOwner)
        updates.push({
          kind,
          rowid: Number(row.rowid),
          threadId: String(before.id),
          before,
          after,
        });
    }
  }
  return updates;
}

// SQLite keeps untouched JSON number tokens; a JavaScript round trip can round historical fields.
function patchedPayload(
  db: NodeSqlite.DatabaseSync,
  table: string,
  rowid: number,
  before: Payload,
  after: Payload,
) {
  let expression = "payload_json";
  const values: NodeSqlite.SQLInputValue[] = [];
  const patch = (previous: unknown, next: unknown, path: string) => {
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (object(previous) && object(next)) {
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]))
        patch(
          Object.hasOwn(previous, key) ? previous[key] : undefined,
          Object.hasOwn(next, key) ? next[key] : undefined,
          path + "." + JSON.stringify(key),
        );
    } else if (Array.isArray(previous) && Array.isArray(next) && previous.length === next.length) {
      for (let index = 0; index < previous.length; index++)
        patch(previous[index], next[index], `${path}[${index}]`);
    } else if (next === undefined) {
      expression = `json_remove(${expression},?)`;
      values.push(path);
    } else {
      expression = `json_set(${expression},?,json(?))`;
      values.push(path, JSON.stringify(next));
    }
  };
  patch(before, after, "$");
  return String(
    db.prepare(`SELECT ${expression} AS payload FROM ${table} WHERE rowid=?`).get(...values, rowid)!
      .payload,
  );
}

function pendingResultTransfers(db: NodeSqlite.DatabaseSync, mode: Mode, now: string) {
  const work = copyWork(db);
  const results: { threadId: string; parentThreadId: string; runId: string }[] = [];
  for (const row of db
    .prepare(`SELECT child.thread_id, json_extract(child.payload_json,'$.lineage.parentThreadId') AS parent_thread_id,
    json_extract(child.payload_json,'$.forkedFrom.nodeId') AS task_id
    FROM orchestration_v2_projection_threads child
    WHERE json_extract(child.payload_json,'$.lineage.relationshipToParent')='subagent'
      AND json_extract(child.payload_json,'$.lineage.parentThreadId') IS NOT NULL
      AND json_extract(child.payload_json,'$.forkedFrom.type')='node'`)
    .all()) {
    const threadId = String(row.thread_id);
    const parentThreadId = String(row.parent_thread_id);
    const transfers = db
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE source_thread_id=? AND target_thread_id=? AND type='subagent_result'",
      )
      .all(threadId, parentThreadId)
      .map((r) => readPayload(r.payload_json));
    let runs: Contracts.OrchestrationV2Run[];
    let messages: Contracts.OrchestrationV2ConversationMessage[];
    try {
      runs = db
        .prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?")
        .all(threadId)
        .map((r) => decodeRun(settle("runs", readPayload(r.payload_json), mode, now, work)));
      messages = db
        .prepare(
          "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND role='user'",
        )
        .all(threadId)
        .map((r) => decodeMessage(readPayload(r.payload_json)));
    } catch {
      throw refuse("delegation-source-schema-rejected");
    }
    const projection = { runs, messages };
    const fallback = delegatedTaskProgress({
      ...projection,
      subagents: [],
      providerThreads: [],
    }).resultRun;
    const selected = new Set<string>();
    const tasks = db
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_subagents WHERE child_thread_id=? AND thread_id=?",
      )
      .all(threadId, parentThreadId)
      .map((r) => settle("subagents", readPayload(r.payload_json), mode, now, work));
    for (const task of tasks) {
      if (task.origin !== "app_owned" || (task.result !== null && transfers.length > 0)) continue;
      const owned = delegatedTaskRuns(projection, Contracts.NodeId.make(String(task.id)));
      const run =
        owned.length > 0
          ? delegatedTaskResultRun(owned)
          : task.id === row.task_id
            ? fallback
            : undefined;
      if (!run || active.has(run.status)) continue;
      if (
        transfers.some(
          (transfer) =>
            object(transfer.sourcePoint) &&
            (transfer.sourcePoint.runId === run.id ||
              (task.id === row.task_id && transfer.sourcePoint.runId === undefined)),
        )
      )
        continue;
      selected.add(run.id);
    }
    if (tasks.length === 0 && transfers.length === 0 && fallback) selected.add(fallback.id);
    for (const runId of selected) results.push({ threadId, parentThreadId, runId });
  }
  return results.map((row) => ({
    id: `context-transfer:offline-neutralise:${NodeCrypto.randomUUID()}`,
    type: "subagent_result",
    sourceThreadId: row.threadId,
    targetThreadId: row.parentThreadId,
    sourcePoint: { threadId: row.threadId, runId: row.runId },
    basePoint: null,
    sourceProviderInstanceId: null,
    targetProviderInstanceId: null,
    targetRunId: null,
    status: "consumed",
    resolution: null,
    createdBy: "system",
    error: null,
    createdAt: now,
    updatedAt: now,
    consumedAt: now,
  }));
}

const impactKinds = [
  "remote-children-still-running",
  "pr-watches-ended",
  "accepted-webhooks-failed",
  "checkpoint-captures-cancelled",
  "attachment-cleanups-cancelled",
  "placeholder-titles-cancelled",
];

function impactCounts(db: NodeSqlite.DatabaseSync): Counts {
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  const effectCount = (kind: string, initialOnly = false) =>
    Number(
      db
        .prepare(
          "SELECT count(*) n FROM orchestration_v2_effect_outbox WHERE status IN ('pending','running') AND effect_type=?" +
            (initialOnly
              ? " AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.kind.type') END='initial'"
              : ""),
        )
        .get(kind)!.n,
    );
  return {
    "remote-children-still-running": count(
      "SELECT count(*) n FROM orchestration_v2_projection_subagents WHERE json_type(payload_json,'$.remoteChild')='object' AND json_type(payload_json,'$.remoteChild.stoppedThere') IS NOT 'true' AND (status IN ('pending','preparing','queued','starting','running','waiting','idle') OR (json_extract(payload_json,'$.result') IS NULL AND json_type(payload_json,'$.completionDelivery') IS NOT 'object'))",
    ),
    "pr-watches-ended": count(
      "SELECT count(*) n FROM orchestration_v2_projection_threads thread,json_each(thread.payload_json,'$.pullRequests') link WHERE json_type(link.value,'$.watch')='object'",
    ),
    "accepted-webhooks-failed": count(
      "SELECT count(*) n FROM scheduled_task_webhook_deliveries WHERE outcome IN ('accepted','coalesced') AND delivery_id IN (SELECT delivery_id FROM scheduled_task_webhook_pending WHERE state IN ('pending','dispatching','running'))",
    ),
    "checkpoint-captures-cancelled": effectCount("checkpoint.capture"),
    "attachment-cleanups-cancelled": effectCount("attachment.cleanup"),
    "placeholder-titles-cancelled": effectCount("thread-title.generate", true),
  };
}

function restartNotices(
  db: NodeSqlite.DatabaseSync,
  plan: ReturnType<typeof projectionPlan>,
  now: string,
) {
  return plan
    .filter(
      (update) =>
        update.kind === "runs" &&
        active.has(String(update.before.status)) &&
        update.before.status !== "queued" &&
        update.after.status === "cancelled",
    )
    .map((update) => {
      const run = update.after;
      const lower = Number(run.ordinal) * 1_000_000;
      const ordinal =
        Number(
          db
            .prepare(
              "SELECT coalesce(max(ordinal),?) n FROM orchestration_v2_turn_item_positions WHERE thread_id=? AND ordinal BETWEEN ? AND ?",
            )
            .get(lower, update.threadId, lower, lower + 999_999)!.n,
        ) + 1;
      if (ordinal > lower + 999_999) throw refuse("turn-item-range-exhausted");
      return {
        id: `turn-item:offline-neutralise:${NodeCrypto.randomUUID()}`,
        threadId: update.threadId,
        runId: String(run.id),
        nodeId: typeof run.rootNodeId === "string" ? run.rootNodeId : null,
        providerThreadId: typeof run.providerThreadId === "string" ? run.providerThreadId : null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: "Server restarted",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "system_notice",
        message: "Cancelled because the server restarted before the provider work completed.",
      };
    });
}

function appendEvent(
  db: NodeSqlite.DatabaseSync,
  threadId: string,
  type: string,
  now: string,
  payload: string,
  metadata: Record<string, unknown> = {},
) {
  const version = Number(
    db
      .prepare(
        "SELECT coalesce(max(stream_version),0)+1 n FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?",
      )
      .get(threadId)!.n,
  );
  db.prepare(
    "INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?,'thread',?,?,?,?,'server',?,?,2)",
  ).run(
    `event:offline-neutralise:${NodeCrypto.randomUUID()}`,
    threadId,
    version,
    type,
    now,
    payload,
    JSON.stringify(metadata),
  );
}

export function neutralisationState(
  db: NodeSqlite.DatabaseSync,
  mode: Mode,
  localNow: DateTime.DateTime,
) {
  const now = DateTime.formatIso(localNow);
  const plan = projectionPlan(db, mode, now);
  const schedules = interruptedSchedules(db, localNow);
  const results = pendingResultTransfers(db, mode, now);
  const notices = restartNotices(db, plan, now);
  const impact = impactCounts(db);
  const before: Counts = {};
  if (notices.length)
    before["orchestration_v2_projection_turn_items / system_notice / completed"] = notices.length;
  if (results.length)
    before["orchestration_v2_projection_context_transfers / consumed-results"] = results.length;
  const rules = scalarRules(mode, now);
  for (const rule of rules) {
    if (rule.table === "orchestration_v2_effect_outbox" && rule.kind === "effects / cancelled") {
      for (const row of db
        .prepare(
          `SELECT effect_type,payload_json FROM orchestration_v2_effect_outbox WHERE ${rule.where}`,
        )
        .iterate()) {
        let kind = "unreadable-effect";
        const historical = historicalEffectTypes.find((type) => type === row.effect_type);
        if (historical) kind = historical;
        else {
          try {
            const request = decodeEffect(JSON.parse(String(row.payload_json)));
            if (request.type === row.effect_type) kind = request.type;
          } catch {
            /* Corrupt request bodies are archived and cancelled without exposing their type. */
          }
        }
        const key = `orchestration_v2_effect_outbox / ${kind} / cancelled`;
        before[key] = (before[key] ?? 0) + 1;
      }
      continue;
    }
    const n = Number(
      db.prepare(`SELECT count(*) n FROM ${rule.table} WHERE ${rule.where}`).get()!.n,
    );
    if (n) before[`${rule.table} / ${rule.kind}`] = n;
  }
  for (const update of plan) {
    let event: Contracts.OrchestrationV2DomainEventJson;
    try {
      event = decodeEvent({
        id: "event:offline-neutralise:validation",
        threadId: update.threadId,
        type: projectionEvents[update.kind],
        occurredAt: now,
        payload: update.after,
      });
    } catch {
      throw refuse("projection-target-schema-rejected");
    }
    const kind = event.type === "turn-item.updated" ? event.payload.type : event.type;
    const state =
      "status" in event.payload
        ? event.payload.status
        : event.type === "message.updated"
          ? "streaming-stopped"
          : "markers-cleared";
    const key = `orchestration_v2_projection_${update.kind} / ${kind} / ${state}`;
    before[key] = (before[key] ?? 0) + 1;
  }

  return { plan, schedules, results, notices, impact, before };
}

export const neutralise = Effect.fn("DataMove.neutralise")(function* (
  path: string,
  mode: Mode,
  verify = false,
) {
  const filename = yield* Effect.try({
    try: () => {
      if (mode !== "cutover" && mode !== "rehearsal") throw refuse("explicit-mode-required");
      const file = assertOffline(path);
      for (const suffix of ["-wal", "-shm", "-journal"]) assertOffline(file + suffix);
      if (!NodeFS.existsSync(file)) throw refuse("existing-database-required");
      return file;
    },
    catch: (error) => (isRefusal(error) ? error : refuse("database-unavailable")),
  });
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(filename, { readOnly: verify }),
      catch: () => refuse("database-unavailable"),
    }),
    (db) =>
      Effect.gen(function* () {
        const version = () => db.prepare("PRAGMA data_version").get()!.data_version;
        const beforeVersion = yield* Effect.try({
          try: () => {
            db.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF");
            return version();
          },
          catch: databaseFailure,
        });
        const archived = yield* archive(filename, true);
        const localNow = yield* DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);
        const now = DateTime.formatIso(localNow);
        return yield* Effect.try({
          try: () => {
            db.exec(verify ? "BEGIN" : "BEGIN EXCLUSIVE");
            try {
              if (version() !== beforeVersion) throw refuse("source-changed-during-verification");
              requireSourceSchema(db);
              const existing = neutralisationMarker(db);
              if (existing !== undefined && existing.mode !== mode)
                throw refuse("neutralisation-mode-mismatch");
              if (
                existing === undefined &&
                (!archived.sourceStillMatches ||
                  archived.missingSelectedCells !== 0 ||
                  archived.selectionCoverage !== "source-schema")
              )
                throw refuse("intact-source-archive-required");
              const {
                plan,
                schedules,
                results,
                notices,
                before,
                impact: currentImpact,
              } = neutralisationState(db, mode, localNow);
              const impact = existing?.impact ?? currentImpact;
              const rules = scalarRules(mode, now);
              if (verify || existing !== undefined) {
                db.exec("ROLLBACK");
                return {
                  mode,
                  marked: existing !== undefined,
                  beforeLive: before,
                  afterLive: before,
                  live: before,
                  changed: {} as Counts,
                  impact,
                };
              }
              for (const notice of notices) {
                try {
                  decodeEvent({
                    id: "event:offline-neutralise:validation",
                    threadId: notice.threadId,
                    type: "turn-item.updated",
                    occurredAt: now,
                    payload: notice,
                  });
                } catch {
                  throw refuse("restart-notice-schema-rejected");
                }
                const payload = JSON.stringify(notice);
                db.prepare(
                  "INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?,?,?,?,?,NULL,NULL,?,'system_notice','completed',?,?)",
                ).run(
                  notice.id,
                  notice.threadId,
                  notice.runId,
                  notice.nodeId,
                  notice.providerThreadId,
                  notice.ordinal,
                  now,
                  payload,
                );
                db.prepare(
                  "INSERT INTO orchestration_v2_turn_item_positions(thread_id,turn_item_id,ordinal) VALUES(?,?,?)",
                ).run(notice.threadId, notice.id, notice.ordinal);
                appendEvent(db, notice.threadId, "turn-item.updated", now, payload, {
                  runId: notice.runId,
                  ...(notice.nodeId === null ? {} : { nodeId: notice.nodeId }),
                });
              }
              for (const update of plan) {
                const table = `orchestration_v2_projection_${update.kind}`;
                const p = update.after;
                const runId =
                  update.kind === "runs"
                    ? p.id
                    : (p.runId ??
                      (update.kind === "provider_turns" && typeof p.nodeId === "string"
                        ? db
                            .prepare(
                              "SELECT run_id FROM orchestration_v2_projection_nodes WHERE node_id=?",
                            )
                            .get(p.nodeId)?.run_id
                        : undefined));
                const nodeId =
                  update.kind === "nodes" || update.kind === "subagents"
                    ? p.id
                    : update.kind === "run_attempts"
                      ? p.rootNodeId
                      : p.nodeId;
                const metadata: Record<string, string> = {};
                for (const [key, value] of [
                  ["runId", runId],
                  ["nodeId", nodeId],
                  ["driver", p.driver],
                  ["providerInstanceId", p.providerInstanceId],
                ] as const)
                  if (typeof value === "string") metadata[key] = value;
                const columns = db.prepare(`PRAGMA table_info(${table})`).all();
                const payload = patchedPayload(
                  db,
                  table,
                  update.rowid,
                  update.before,
                  update.after,
                );
                const changes: Record<string, NodeSqlite.SQLInputValue> = {
                  payload_json: payload,
                };
                for (const name of [
                  "status",
                  "completed_at",
                  "resolved_at",
                  "updated_at",
                  "streaming",
                  "provider_session_id",
                  "active_provider_thread_id",
                ]) {
                  if (!columns.some((column) => column.name === name)) continue;
                  const field = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
                  const value = update.after[field];
                  if (value === null || typeof value === "string" || typeof value === "number")
                    changes[name] = value;
                  else if (typeof value === "boolean") changes[name] = Number(value);
                }
                if (update.kind === "subagents" && object(update.after.completionDelivery))
                  changes.completion_delivery_state = String(update.after.completionDelivery.state);
                db.prepare(
                  `UPDATE ${table} SET ${Object.keys(changes)
                    .map((name) => `${q(name)}=?`)
                    .join(",")} WHERE rowid=?`,
                ).run(...Object.values(changes), update.rowid);
                const streamVersion = Number(
                  db
                    .prepare(
                      "SELECT coalesce(max(stream_version),0)+1 AS n FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?",
                    )
                    .get(update.threadId)!.n,
                );
                db.prepare(
                  `INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?,'thread',?,?,?,?,'server',?,?,2)`,
                ).run(
                  `event:offline-neutralise:${NodeCrypto.randomUUID()}`,
                  update.threadId,
                  streamVersion,
                  projectionEvents[update.kind],
                  now,
                  payload,
                  JSON.stringify(metadata),
                );
              }
              for (const result of results) {
                db.prepare(`INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,target_run_id,type,status,source_provider,target_provider,updated_at,payload_json,source_provider_instance_id,target_provider_instance_id)
                VALUES(?,?,?,NULL,'subagent_result','consumed',NULL,NULL,?,?,NULL,NULL)`).run(
                  result.id,
                  result.sourceThreadId,
                  result.targetThreadId,
                  now,
                  JSON.stringify(result),
                );
                const streamVersion = Number(
                  db
                    .prepare(
                      "SELECT coalesce(max(stream_version),0)+1 AS n FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?",
                    )
                    .get(result.sourceThreadId)!.n,
                );
                db.prepare(
                  `INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?,'thread',?,?,?,?,'server',?,?,2)`,
                ).run(
                  `event:offline-neutralise:${NodeCrypto.randomUUID()}`,
                  result.sourceThreadId,
                  streamVersion,
                  "context-transfer.updated",
                  now,
                  JSON.stringify(result),
                  JSON.stringify({ runId: result.sourcePoint.runId }),
                );
              }
              for (const rule of rules)
                db.prepare(
                  rule.set === null
                    ? `DELETE FROM ${rule.table} WHERE ${rule.where}`
                    : `UPDATE ${rule.table} SET ${rule.set} WHERE ${rule.where}`,
                ).run(...rule.values);
              for (const schedule of schedules)
                db.prepare(
                  "UPDATE scheduled_tasks SET next_run_at=?,run_count=run_count+? WHERE rowid=?",
                ).run(
                  mode === "rehearsal" ? null : schedule.nextRunAt,
                  schedule.countDelta,
                  schedule.rowid,
                );
              for (const threadId of new Set([
                ...plan.map((update) => update.threadId),
                ...results.map((result) => result.sourceThreadId),
              ]))
                db.prepare(
                  "UPDATE orchestration_v2_projection_threads SET updated_at=?,payload_json=json_set(payload_json,'$.updatedAt',?) WHERE thread_id=?",
                ).run(now, now, threadId);
              if (
                projectionPlan(db, mode, now).length ||
                pendingResultTransfers(db, mode, now).length ||
                rules.some((rule) =>
                  db.prepare(`SELECT 1 FROM ${rule.table} WHERE ${rule.where} LIMIT 1`).get(),
                )
              )
                throw refuse("executable-state-remains");
              db.prepare(
                "UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT coalesce(max(sequence),0) FROM orchestration_events),updated_at=? WHERE projection_name='thread-projections'",
              ).run(now);
              db.exec(stateDefinition);
              db.prepare(`INSERT INTO ${stateTable} VALUES(1,2,?,?,?)`).run(
                mode,
                now,
                JSON.stringify(impact),
              );
              db.exec("COMMIT");
              return {
                mode,
                marked: true,
                beforeLive: before,
                afterLive: {} as Counts,
                live: {} as Counts,
                changed: before,
                impact,
              };
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          },
          catch: databaseFailure,
        });
      }),
    (db) => Effect.sync(() => db.close()),
  );
});
