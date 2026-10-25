#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Argument parsing and file checks for an isolated fixture home.

/**
 * Fills an isolated, already-migrated home with about a thousand synthetic threads shaped like a
 * long-lived real server. Writes go through EventSink but skip migrations: the home's schema must
 * stay the one its (possibly older) server created. Stop the server that owns the home first.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { forkMigrationManifest } from "../src/persistence/ForkMigrations.ts";
import { migrationManifest } from "../src/persistence/Migrations.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "base-dir": { type: "string" },
    threads: { type: "string", default: "1000" },
    projects: { type: "string", default: "20" },
    "provider-turn-updates": { type: "string", default: "4" },
    "payload-scale": { type: "string", default: "1" },
    seed: { type: "string", default: "1" },
  },
});
const usage = `Usage: generate-large-state-fixture.ts --base-dir <isolated home>
  [--threads 1000] [--projects 20] [--provider-turn-updates 4] [--payload-scale 1] [--seed 1]`;
const positiveNumber = (name: string, value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`--${name} must be positive\n${usage}`);
  return parsed;
};
if (!values["base-dir"]) throw new Error(usage);
const baseDir = NodeFS.realpathSync(values["base-dir"]);
for (const name of [".styal", ".t3"]) {
  const liveHome = NodePath.join(NodeOS.homedir(), name);
  if (NodeFS.existsSync(liveHome) && baseDir === NodeFS.realpathSync(liveHome)) {
    throw new Error("Use an isolated home, not the shared install");
  }
}
const databasePath = NodePath.join(baseDir, "userdata/statev2.sqlite");
if (!NodeFS.existsSync(databasePath)) {
  throw new Error("Start the server once against this home to create its database, then stop it");
}
const threadCount = Math.round(positiveNumber("threads", values.threads));
const projectCount = Math.round(positiveNumber("projects", values.projects));
// A real provider turn is rewritten for every token usage report; each one is another event row.
const providerTurnUpdates = Math.round(
  positiveNumber("provider-turn-updates", values["provider-turn-updates"]),
);
const payloadScale = positiveNumber("payload-scale", values["payload-scale"]);

// mulberry32: deterministic so a seed reproduces the same database.
let randomState = Math.round(positiveNumber("seed", values.seed)) >>> 0;
const random = () => {
  randomState = (randomState + 0x6d2b79f5) >>> 0;
  let t = randomState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <A>(items: ReadonlyArray<A>): A => items[Math.floor(random() * items.length)]!;
const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
/** Long-tailed counts and sizes: real histories have a few enormous threads and outputs. */
const logNormal = (median: number, sigma: number, max: number) =>
  Math.min(max, Math.max(1, Math.round(median * Math.exp(sigma * normal()))));

// Pseudo-words from fixed syllables, so text compresses like prose without copying any.
const syllables = ["ka", "lo", "mi", "ren", "tor", "vex", "sa", "qui", "dor", "pel", "an", "is"];
const words = Array.from({ length: 400 }, () =>
  Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(syllables)).join(""),
);
const textPool = Array.from({ length: 300_000 }, (_, index) =>
  index % 17 === 16 ? `${pick(words)}.\n` : pick(words),
).join(" ");
const text = (length: number) => {
  const size = Math.max(1, Math.round(length * payloadScale));
  if (size >= textPool.length)
    return textPool.repeat(Math.ceil(size / textPool.length)).slice(0, size);
  const start = Math.floor(random() * (textPool.length - size));
  return textPool.slice(start, start + size);
};

const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "synthetic-model" };
const projectIds = Array.from({ length: projectCount }, (_, index) =>
  ProjectId.make(`project:fixture:${index}`),
);
const timelineStart = Date.parse("2026-01-01T00:00:00.000Z");
const timelineEnd = Date.parse("2026-06-01T00:00:00.000Z");

type Unit =
  | { readonly kind: "thread"; readonly at: number; readonly thread: PlannedThread }
  | { readonly kind: "run"; readonly at: number; readonly thread: PlannedThread }
  | {
      readonly kind: "history";
      readonly at: number;
      readonly thread: PlannedThread;
      readonly items: number;
    };

interface PlannedThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly createdAt: number;
  readonly providerThreadId: ProviderThreadId;
  nextItemOrdinal: number;
  runsWritten: number;
}

// Half of a long-lived server's threads hold history without runs (imports from the old
// orchestration); the rest have runs, most only one and a few hundreds.
const units: Array<Unit> = [];
for (let index = 0; index < threadCount; index += 1) {
  const createdAt = timelineStart + random() * (timelineEnd - timelineStart) * 0.9;
  const thread: PlannedThread = {
    id: ThreadId.make(`thread:fixture:${index}`),
    projectId: pick(projectIds),
    createdAt,
    providerThreadId: ProviderThreadId.make(`provider-thread:fixture:${index}`),
    nextItemOrdinal: 1,
    runsWritten: 0,
  };
  units.push({ kind: "thread", at: createdAt, thread });
  const later = () => createdAt + 1 + random() * (timelineEnd - createdAt - 1);
  if (index % 2 === 0) {
    const runs = logNormal(1, 1.95, 450);
    for (let run = 0; run < runs; run += 1) units.push({ kind: "run", at: later(), thread });
  } else {
    let remaining = logNormal(60, 1.3, 6000);
    while (remaining > 0) {
      const items = Math.min(remaining, 40);
      units.push({ kind: "history", at: later(), thread, items });
      remaining -= items;
    }
  }
}
units.sort((left, right) => left.at - right.at);

let eventCounter = 0;
const stamp = (at: number) => ({
  id: EventId.make(`event:fixture:${(eventCounter += 1)}`),
  occurredAt: DateTime.makeUnsafe(at),
});
const utc = (at: number) => DateTime.makeUnsafe(at);

const threadPayload = (thread: PlannedThread, at: number): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: thread.id,
  projectId: thread.projectId,
  title: text(24 + Math.floor(random() * 40)).trim() || "Synthetic thread",
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: `fixture/${thread.id.slice(-6)}`,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: thread.id },
  forkedFrom: null,
  createdAt: utc(at),
  updatedAt: utc(at),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

type ItemContext = {
  readonly thread: PlannedThread;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly at: number;
};

/** One turn item and the events a provider leaves for it: a running update, then the final one. */
const itemEvents = (context: ItemContext): Array<OrchestrationV2DomainEvent> => {
  const { thread, runId, at } = context;
  const ordinal = thread.nextItemOrdinal++;
  const id = TurnItemId.make(`item:${thread.id}:${ordinal}`);
  const base = {
    id,
    threadId: thread.id,
    runId,
    nodeId: context.nodeId,
    providerThreadId: runId === null ? null : thread.providerThreadId,
    providerTurnId: context.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    title: null,
    startedAt: utc(at),
    updatedAt: utc(at),
  };
  const roll = random();
  const events: Array<OrchestrationV2DomainEvent> = [];
  const push = (item: OrchestrationV2TurnItem) =>
    events.push({
      ...stamp(at),
      type: "turn-item.updated",
      threadId: thread.id,
      ...(runId === null ? {} : { runId }),
      payload: item,
    });
  if (roll < 0.56) {
    const failed = random() < 0.06;
    const command = {
      ...base,
      type: "command_execution" as const,
      title: "Run command",
      input: `vp test run src/${pick(words)}/${pick(words)}.test.ts`,
    };
    if (random() < 0.5) push({ ...command, status: "running", completedAt: null, output: "" });
    push({
      ...command,
      status: failed ? "failed" : "completed",
      completedAt: utc(at),
      output: text(logNormal(1500, 1.4, 1_500_000)),
      exitCode: failed ? 1 : 0,
    });
  } else if (roll < 0.72) {
    const messageId = MessageId.make(`message:${id}`);
    const body = text(logNormal(500, 0.9, 60_000));
    push({
      ...base,
      type: "assistant_message",
      status: "completed",
      completedAt: utc(at),
      messageId,
      text: body,
      streaming: false,
    });
    events.push({
      ...stamp(at),
      type: "message.updated",
      threadId: thread.id,
      ...(runId === null ? {} : { runId }),
      payload: {
        createdBy: "agent",
        creationSource: "web",
        id: messageId,
        threadId: thread.id,
        runId,
        nodeId: context.nodeId,
        role: "assistant",
        text: body,
        attachments: [],
        streaming: false,
        createdAt: utc(at),
        updatedAt: utc(at),
      },
    });
  } else if (roll < 0.88) {
    push({
      ...base,
      type: "reasoning",
      status: "completed",
      completedAt: utc(at),
      text: text(logNormal(700, 0.9, 40_000)),
      streaming: false,
    });
  } else if (roll < 0.96) {
    push({
      ...base,
      type: "dynamic_tool",
      status: "completed",
      completedAt: utc(at),
      toolName: `synthetic_${pick(words)}`,
      input: { query: text(80) },
      output: { content: text(logNormal(4000, 1.9, 2_000_000)) },
    });
  } else {
    const before = text(logNormal(600, 1, 50_000));
    push({
      ...base,
      type: "file_change",
      status: "completed",
      completedAt: utc(at),
      fileName: `src/${pick(words)}/${pick(words)}.ts`,
      additions: 1 + Math.floor(random() * 40),
      deletions: Math.floor(random() * 20),
      diffStr: `@@ -1,4 +1,6 @@\n-${before}\n+${text(before.length)}`,
    });
  }
  return events;
};

const userMessageEvents = (context: ItemContext, messageId: MessageId) => {
  const { thread, runId, at } = context;
  const body = text(logNormal(600, 1, 40_000));
  const ordinal = thread.nextItemOrdinal++;
  return [
    {
      ...stamp(at),
      type: "message.updated",
      threadId: thread.id,
      ...(runId === null ? {} : { runId }),
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: messageId,
        threadId: thread.id,
        runId,
        nodeId: null,
        role: "user",
        text: body,
        attachments: [],
        streaming: false,
        createdAt: utc(at),
        updatedAt: utc(at),
      },
    },
    {
      ...stamp(at),
      type: "turn-item.updated",
      threadId: thread.id,
      ...(runId === null ? {} : { runId }),
      payload: {
        id: TurnItemId.make(`item:${thread.id}:${ordinal}`),
        threadId: thread.id,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        title: null,
        startedAt: utc(at),
        updatedAt: utc(at),
        completedAt: utc(at),
        type: "user_message",
        status: "completed",
        createdBy: "user",
        creationSource: "web",
        messageId,
        inputIntent: "turn_start",
        text: body,
        attachments: [],
      },
    },
  ] satisfies Array<OrchestrationV2DomainEvent>;
};

const runEvents = (thread: PlannedThread, ordinal: number, at: number) => {
  const runId = RunId.make(`run:${thread.id}:${ordinal}`);
  const attemptId = RunAttemptId.make(`attempt:${runId}`);
  const rootNodeId = NodeId.make(`node:${runId}:root`);
  const providerTurnId = ProviderTurnId.make(`provider-turn:${runId}`);
  const userMessageId = MessageId.make(`message:${runId}:user`);
  const itemCount = logNormal(10, 1.45, 2000);
  const end = at + 1000 * (5 + itemCount * 3);
  const events: Array<OrchestrationV2DomainEvent> = [];
  const context: ItemContext = { thread, runId, nodeId: null, providerTurnId: null, at };
  events.push(...userMessageEvents(context, userMessageId));
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: thread.id,
    ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: thread.providerThreadId,
    userMessageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "running",
    requestedAt: utc(at),
    startedAt: utc(at),
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  events.push({ ...stamp(at), type: "run.created", threadId: thread.id, runId, payload: run });
  const providerThread: OrchestrationV2ProviderThread = {
    id: thread.providerThreadId,
    appThreadId: thread.id,
    ownerNodeId: null,
    driver,
    providerInstanceId,
    providerSessionId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: ordinal,
    handoffIds: [],
    forkedFrom: null,
    createdAt: utc(thread.createdAt),
    updatedAt: utc(at),
  };
  events.push({
    ...stamp(at),
    type: "provider-thread.updated",
    threadId: thread.id,
    payload: providerThread,
  });
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId,
    providerInstanceId,
    providerThreadId: thread.providerThreadId,
    providerTurnId,
    reason: "initial",
    status: "running",
    startedAt: utc(at),
    completedAt: null,
  };
  events.push({
    ...stamp(at),
    type: "run-attempt.created",
    threadId: thread.id,
    runId,
    payload: attempt,
  });
  const root: OrchestrationV2ExecutionNode = {
    id: rootNodeId,
    threadId: thread.id,
    runId,
    parentNodeId: null,
    rootNodeId,
    kind: "root_turn",
    status: "running",
    countsForRun: true,
    providerThreadId: thread.providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: utc(at),
    completedAt: null,
  };
  events.push({
    ...stamp(at),
    type: "node.updated",
    threadId: thread.id,
    runId,
    nodeId: rootNodeId,
    payload: root,
  });
  const turn: OrchestrationV2ProviderTurn = {
    id: providerTurnId,
    providerThreadId: thread.providerThreadId,
    nodeId: rootNodeId,
    runAttemptId: attemptId,
    nativeTurnRef: null,
    ordinal,
    status: "running",
    startedAt: utc(at),
    completedAt: null,
  };
  const usage = (scale: number) => ({
    inputTokens: Math.round(40_000 * scale * ordinal),
    cachedInputTokens: Math.round(30_000 * scale * ordinal),
    cacheCreationTokens: 0,
    outputTokens: Math.round(2_000 * scale * ordinal),
    reasoningTokens: Math.round(800 * scale * ordinal),
    countedTurns: ordinal,
    turns: ordinal,
    partialTurns: 0,
    subagentTurns: 0,
  });
  for (let update = 0; update < providerTurnUpdates; update += 1) {
    events.push({
      ...stamp(at),
      type: "provider-turn.updated",
      threadId: thread.id,
      runId,
      nodeId: rootNodeId,
      driver,
      payload: { ...turn, threadTokenUsage: usage((update + 1) / providerTurnUpdates) },
    });
  }
  for (let index = 0; index < itemCount; index += 1) {
    const itemAt = at + 1000 * (index + 1) * 3;
    // About half of a run's items are tool calls with their own execution node.
    const nodeId = random() < 0.5 ? NodeId.make(`node:${runId}:${index}`) : null;
    if (nodeId !== null) {
      events.push({
        ...stamp(itemAt),
        type: "node.updated",
        threadId: thread.id,
        runId,
        nodeId,
        payload: {
          ...root,
          id: nodeId,
          parentNodeId: rootNodeId,
          kind: "tool_call",
          status: "completed",
          completedAt: utc(itemAt),
        },
      });
    }
    events.push(...itemEvents({ thread, runId, nodeId, providerTurnId, at: itemAt }));
  }
  events.push(
    {
      ...stamp(end),
      type: "provider-turn.updated",
      threadId: thread.id,
      runId,
      nodeId: rootNodeId,
      driver,
      payload: { ...turn, status: "completed", completedAt: utc(end), threadTokenUsage: usage(1) },
    },
    {
      ...stamp(end),
      type: "node.updated",
      threadId: thread.id,
      runId,
      nodeId: rootNodeId,
      payload: { ...root, status: "completed", completedAt: utc(end) },
    },
    {
      ...stamp(end),
      type: "run-attempt.updated",
      threadId: thread.id,
      runId,
      payload: { ...attempt, status: "completed", completedAt: utc(end) },
    },
    {
      ...stamp(end),
      type: "run.updated",
      threadId: thread.id,
      runId,
      payload: { ...run, status: "completed", completedAt: utc(end) },
    },
    {
      ...stamp(end),
      type: "provider-thread.updated",
      threadId: thread.id,
      payload: { ...providerThread, status: "idle", updatedAt: utc(end) },
    },
  );
  return events;
};

const historyEvents = (thread: PlannedThread, items: number, at: number) => {
  const events: Array<OrchestrationV2DomainEvent> = [];
  for (let index = 0; index < items; index += 1) {
    const context = {
      thread,
      runId: null,
      nodeId: null,
      providerTurnId: null,
      at: at + index * 1000,
    };
    events.push(
      ...(index === 0
        ? userMessageEvents(
            context,
            MessageId.make(`message:${thread.id}:${thread.nextItemOrdinal}`),
          )
        : itemEvents(context)),
    );
  }
  return events;
};

const reportMigrationDrift = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const applied = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM effect_sql_migrations
      UNION ALL SELECT name FROM yngatech_sql_migrations
    `).map((row) => row.name),
  );
  const missing = [...migrationManifest, ...forkMigrationManifest]
    .map(([, name]) => name)
    .filter((name) => !applied.has(name));
  if (missing.length > 0) {
    // An older server's home lacks this checkout's newest migrations. Writes still go through
    // this checkout's projector; one that touches a changed table fails loudly below.
    yield* Effect.logInfo(
      `Database predates ${missing.length} migration(s): ${missing.join(", ")}`,
    );
  }
});

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  // A throwaway fixture: a crash only means generating it again, so leave WAL, which writes
  // every page twice, until the end. The server expects WAL.
  yield* sql`PRAGMA journal_mode = DELETE`;
  yield* sql`PRAGMA synchronous = OFF`;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA cache_size = -262144`;
  yield* reportMigrationDrift;
  const startedAt = performance.now();
  for (const [index, projectId] of projectIds.entries()) {
    const at = DateTime.makeUnsafe(timelineStart);
    yield* sink.commitProjectCommand({
      commandId: CommandId.make(`command:fixture:project:${index}`),
      projectId,
      commandType: "project.create",
      acceptedAt: at,
      event: {
        eventId: EventId.make(`event:fixture:project:${index}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(at),
        commandId: CommandId.make(`command:fixture:project:${index}`),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: `Fixture project ${index}`,
          workspaceRoot: NodePath.join(baseDir, "workspaces", `project-${index}`),
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(at),
          updatedAt: DateTime.formatIso(at),
        },
      },
    });
  }
  let written = 0;
  for (const [index, unit] of units.entries()) {
    const events =
      unit.kind === "thread"
        ? [
            {
              ...stamp(unit.at),
              type: "thread.created" as const,
              threadId: unit.thread.id,
              payload: threadPayload(unit.thread, unit.at),
            },
          ]
        : unit.kind === "run"
          ? runEvents(unit.thread, (unit.thread.runsWritten += 1), unit.at)
          : historyEvents(unit.thread, unit.items, unit.at);
    yield* sink.write({ events });
    written += events.length;
    if (index % 500 === 0) {
      yield* Effect.logInfo(
        `${index}/${units.length} units, ${written} events, ${((performance.now() - startedAt) / 1000).toFixed(0)}s`,
      );
    }
  }
  yield* sql`PRAGMA journal_mode = WAL`;
  const counts = yield* sql<{ readonly name: string; readonly rows: number }>`
    SELECT 'threads' AS name, COUNT(*) AS rows FROM orchestration_v2_projection_threads
    UNION ALL SELECT 'runs', COUNT(*) FROM orchestration_v2_projection_runs
    UNION ALL SELECT 'turn items', COUNT(*) FROM orchestration_v2_projection_turn_items
    UNION ALL SELECT 'messages', COUNT(*) FROM orchestration_v2_projection_messages
    UNION ALL SELECT 'provider turns', COUNT(*) FROM orchestration_v2_projection_provider_turns
    UNION ALL SELECT 'events', COUNT(*) FROM orchestration_events
  `;
  yield* Effect.logInfo(
    `Wrote ${written} events in ${((performance.now() - startedAt) / 1000).toFixed(1)}s; ` +
      `${counts.map((row) => `${row.rows} ${row.name}`).join(", ")}; ` +
      `${(NodeFS.statSync(databasePath).size / 1024 / 1024).toFixed(0)} MB`,
  );
});

const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
);

await Effect.runPromise(program.pipe(Effect.provide(layer)));
