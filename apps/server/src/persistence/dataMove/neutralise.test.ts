// @effect-diagnostics nodeBuiltinImport:off - Synthetic offline SQLite tests.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeZlib from "node:zlib";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCryptoServices from "@effect/platform-node/NodeCrypto";
import * as Result from "effect/Result";
import * as Contracts from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import * as Checkpoints from "../../orchestration-v2/CheckpointService.ts";
import * as CommandPolicy from "../../orchestration-v2/CommandPolicy.ts";
import * as Handoffs from "../../orchestration-v2/ContextHandoffService.ts";
import * as Receipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Projects from "../../orchestration-v2/ProjectStore.ts";
import * as TaskFolders from "../../workspace/TaskFolderStore.ts";
import * as Adapters from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Sessions from "../../orchestration-v2/ProviderSessionManager.ts";
import * as Switch from "../../orchestration-v2/ProviderSwitchService.ts";
import * as Policy from "../../orchestration-v2/RuntimePolicy.ts";
import * as Forks from "../../orchestration-v2/ThreadForkService.ts";
import * as Commands from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Continuations from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedFolders from "../../project/ManagedProjectFolders.ts";
import * as Secrets from "../../secrets/SecretRequests.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as Remote from "../../peer/RemoteDelegation.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerClient from "../../peer/PeerMcpClient.ts";
import * as Forwarding from "../../peer/PeerForwarding.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as SecretStore from "../../auth/ServerSecretStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentity from "../../project/RepositoryIdentityResolver.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionReplay from "../../orchestration-v2/testkit/ProjectionReplay.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProviderRecovery from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Settings from "../../serverSettings.ts";
import * as Maintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as UsageRecovery from "../../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as PrWatch from "../../orchestration-v2/PullRequestWatchReactor.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PullRequests from "../../pullRequest/PullRequestService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { runAllMigrations } from "../ForkMigrations.ts";
import { archive } from "./archive.ts";
import { neutralise } from "./neutralise.ts";
import { preflight } from "./preflight.ts";
import source from "./source.json" with { type: "json" };

function edit(file: string, run: (db: NodeSqlite.DatabaseSync) => void) {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    run(db);
  } finally {
    db.close();
  }
}
function hash(file: string, tables: readonly string[], taskConfiguration = false) {
  const digest = NodeCrypto.createHash("sha256");
  edit(file, (db) => {
    for (const table of tables) {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
        continue;
      const columns =
        table === "scheduled_tasks" && taskConfiguration
          ? source.definitions
              .find((d) => d.name === table)!
              .columns.filter(
                (c) =>
                  ![
                    "updated_at",
                    "next_run_at",
                    "last_run_status",
                    "last_run_error",
                    "run_count",
                  ].includes(c.name),
              )
              .map((c) => `"${c.name}"`)
              .join(",")
          : "*";
      digest.update(JSON.stringify(db.prepare(`SELECT ${columns} FROM "${table}"`).all()));
    }
  });
  return digest.digest("hex");
}
const kept = [
  "projection_projects",
  "scheduled_tasks",
  "auth_sessions",
  "auth_pairing_links",
  "peer_environment_links",
  "provider_session_runtime",
  "hardware_leases",
  "projection_thread_sessions",
  "projection_thread_messages",
  "orchestration_v2_projection_messages",
];

function terminalRows(file: string) {
  const rows: { table: string; rowid: number; hash: string }[] = [];
  edit(file, (db) => {
    for (const definition of source.definitions.filter(
      (d) =>
        d.type === "table" &&
        d.name.includes("projection") &&
        d.columns.some((c) => c.name === "status"),
    )) {
      for (const row of db
        .prepare(
          `SELECT rowid AS snapshot_rowid,* FROM ${definition.name} WHERE status NOT IN ('active','pending','preparing','queued','starting','running','waiting','idle','not_loaded'${definition.name.endsWith("provider_sessions") ? ",'ready'" : ""})`,
        )
        .all()) {
        const { snapshot_rowid, ...data } = row;
        rows.push({
          table: definition.name,
          rowid: Number(snapshot_rowid),
          hash: NodeCrypto.createHash("sha256").update(JSON.stringify(data)).digest("hex"),
        });
      }
    }
  });
  return rows;
}

function expectTerminalRows(file: string, rows: ReturnType<typeof terminalRows>) {
  edit(file, (db) => {
    for (const row of rows) {
      const data = db.prepare(`SELECT * FROM ${row.table} WHERE rowid=?`).get(row.rowid);
      expect(
        NodeCrypto.createHash("sha256").update(JSON.stringify(data)).digest("hex"),
        row.table,
      ).toBe(row.hash);
    }
  });
}

function executionFixture(db: NodeSqlite.DatabaseSync) {
  const at = "2026-01-01T00:00:00.000Z";
  const events: Record<string, string> = {
    threads: "thread.created",
    runs: "run.created",
    run_attempts: "run-attempt.created",
    nodes: "node.updated",
    provider_turns: "provider-turn.updated",
    provider_sessions: "provider-session.updated",
    provider_threads: "provider-thread.updated",
    runtime_requests: "runtime-request.updated",
    messages: "message.updated",
    subagents: "subagent.updated",
    turn_items: "turn-item.updated",
    context_handoffs: "context-handoff.updated",
    context_transfers: "context-transfer.updated",
  };
  const put = (kind: string, id: string, patch: Record<string, unknown>) => {
    const table = "orchestration_v2_projection_" + kind;
    const base = db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1`).get()!;
    const original = JSON.parse(String(base.payload_json)) as Record<string, unknown>;
    if (kind === "turn_items" && patch.type !== undefined && patch.type !== original.type)
      for (const key of Object.keys(original))
        if (
          ![
            "id",
            "threadId",
            "runId",
            "nodeId",
            "providerThreadId",
            "providerTurnId",
            "nativeItemRef",
            "parentItemId",
            "ordinal",
            "status",
            "title",
            "startedAt",
            "completedAt",
            "updatedAt",
          ].includes(key)
        )
          delete original[key];
    const p: Record<string, unknown> = {
      ...original,
      ...patch,
      id,
    };
    if (p.type === "user_message") delete p.streaming;
    const row = { ...base };
    const definition = source.definitions.find((d) => d.name === table)!;
    for (const column of definition.columns) {
      const field = column.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (column.pk) row[column.name] = id;
      else if (column.name === "payload_json") row[column.name] = JSON.stringify(p);
      else if (column.name === "thread_id")
        row[column.name] = String(p.threadId ?? p.appThreadId ?? "ordinary");
      else if (p[field] === null || typeof p[field] === "string" || typeof p[field] === "number")
        row[column.name] = p[field] as string | number | null;
      else if (typeof p[field] === "boolean") row[column.name] = Number(p[field]);
    }
    db.prepare(
      `INSERT OR REPLACE INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
    ).run(...Object.values(row));
    const threadId = kind === "threads" ? id : String(p.threadId ?? p.appThreadId ?? "ordinary");
    const version = Number(
      db
        .prepare(
          "SELECT coalesce(max(stream_version),0)+1 n FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?",
        )
        .get(threadId)!.n,
    );
    db.prepare(
      `INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?,'thread',?,?,?,?,'server',?,'{}',2)`,
    ).run(
      "event:synthetic:" + id + ":" + version,
      threadId,
      version,
      events[kind]!,
      at,
      JSON.stringify(p),
    );
  };
  // The base fixture tests orphan import too; this recovery proof needs a complete graph.
  put("threads", "orphan-fork", {
    lineage: { parentThreadId: "ordinary", relationshipToParent: "fork", rootThreadId: "ordinary" },
    forkedFrom: { type: "run", threadId: "ordinary", runId: "run-alpha" },
  });
  put("threads", "ordinary", {
    pullRequests: [
      {
        host: "example.test",
        repository: "synthetic/project",
        number: 1,
        url: "https://example.test/synthetic/project/pull/1",
        source: "manual",
        linkedAt: at,
        snapshot: null,
        stack: null,
        watch: {
          startedAt: at,
          headSha: null,
          failedChecks: [],
          passed: false,
          remarksThrough: at,
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      },
    ],
    titleRegeneration: { requestId: "synthetic-title-job", startedAt: at },
    rollbackRequestId: "synthetic-rollback",
    limitRecovery: { runId: "run-alpha", resetAt: "2099-01-01T00:00:00.000Z", autoResume: true },
    guestShare: {
      id: "synthetic-guest-share",
      host: "share.example.test",
      createdAt: at,
      expiresAt: "2099-01-01T00:00:00.000Z",
      guestName: "Synthetic guest",
      messages: [
        {
          id: "synthetic-guest-message",
          text: "Synthetic held guest input",
          status: "pending",
          submittedAt: at,
        },
      ],
    },
  });
  for (const [index, status] of ["preparing", "queued", "starting", "waiting"].entries())
    put("runs", "synthetic-run-" + status, {
      ordinal: 100 + index,
      status,
      completedAt: null,
      startedAt: null,
      queueHeld: true,
      steerWhenReadyRunId: "run-alpha",
      restartContinuationOfRunId: "run-alpha",
      userMessageId: "synthetic-queued-message",
    });
  put("runs", "synthetic-delivery", {
    ordinal: 110,
    status: "completed",
    delegatedCompletion: {
      disposition: "open",
      nextGeneration: 2,
      delivery: {
        generation: 1,
        messageId: "synthetic-delivery-message",
        taskIds: ["synthetic-app-task"],
      },
    },
  });
  put("messages", "synthetic-queued-message", {
    createdBy: "user",
    creationSource: "web",
    role: "user",
    runId: "synthetic-run-queued",
    text: "Synthetic queued input",
  });
  put("turn_items", "synthetic-queued-item", {
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    status: "pending",
    inputIntent: "queued_turn",
    runId: "synthetic-run-queued",
    messageId: "synthetic-queued-message",
    text: "Synthetic queued input",
    attachments: [],
    ordinal: 100,
    completedAt: null,
    nodeId: "synthetic-queue-node",
    providerThreadId: "synthetic-native-thread",
  });
  put("runs", "synthetic-run-queued", {
    status: "queued",
    startedAt: null,
    completedAt: null,
    queueHeld: false,
    queuePosition: 1,
    rootNodeId: "synthetic-queue-node",
    activeAttemptId: "synthetic-queue-attempt",
    providerThreadId: "synthetic-native-thread",
    userMessageId: "synthetic-queued-message",
    ordinal: 101,
    restartContinuationOfRunId: undefined,
    steerWhenReadyRunId: undefined,
  });
  put("nodes", "synthetic-queue-node", {
    runId: "synthetic-run-queued",
    kind: "root_turn",
    parentNodeId: null,
    status: "pending",
    startedAt: null,
    completedAt: null,
    providerThreadId: "synthetic-native-thread",
  });
  put("run_attempts", "synthetic-queue-attempt", {
    runId: "synthetic-run-queued",
    rootNodeId: "synthetic-queue-node",
    providerThreadId: "synthetic-native-thread",
    status: "pending",
    startedAt: null,
    completedAt: null,
  });
  put("context_handoffs", "synthetic-deferred-handoff", {
    targetRunId: "synthetic-run-queued",
    status: "pending",
    delivery: undefined,
  });
  put("run_attempts", "synthetic-pending-attempt", {
    status: "pending",
    attemptOrdinal: 100,
    completedAt: null,
    nativeThreadId: "synthetic-native-attempt",
  });
  for (const status of ["pending", "waiting"])
    put("nodes", "synthetic-node-" + status, {
      status,
      completedAt: null,
      nativeItemRef: { driver: "codex", nativeId: "synthetic-native-node", strength: "strong" },
    });
  for (const [index, status] of ["pending", "running"].entries())
    put("provider_turns", "synthetic-turn-" + status, {
      status,
      ordinal: 100 + index,
      completedAt: null,
      nativeThreadRef: {
        driver: "codex",
        nativeId: "synthetic-native-turn-thread",
        strength: "strong",
      },
      nativeTurnRef: { driver: "codex", nativeId: "synthetic-native-turn", strength: "strong" },
    });
  for (const status of ["starting", "running", "waiting", "error"])
    put("provider_sessions", "synthetic-session-" + status, {
      status,
      extensionStatuses: [{ key: "synthetic", text: "Synthetic startup" }],
    });
  put("provider_threads", "synthetic-native-thread", {
    status: "idle",
    providerSessionId: "synthetic-session",
    nativeThreadRef: { driver: "codex", nativeId: "synthetic-live-session", strength: "strong" },
    pendingBackgroundTasks: ["subagent", "monitor", "background_task", "command"].map((kind) => ({
      kind,
      taskId: "synthetic-" + kind,
      awaited: true,
    })),
  });
  put("runtime_requests", "synthetic-live-request", {
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "synthetic-session" },
    resolvedAt: null,
    nativeRequestRef: { driver: "codex", nativeId: "synthetic-native-request", strength: "strong" },
  });
  for (const status of ["idle", "pending", "waiting"])
    put("subagents", "synthetic-task-" + status, { status, completedAt: null });
  put("threads", "synthetic-child", {
    pullRequests: [],
    guestShare: null,
    titleRegeneration: null,
    rollbackRequestId: undefined,
    limitRecovery: null,
    lineage: {
      parentThreadId: "ordinary",
      relationshipToParent: "subagent",
      rootThreadId: "ordinary",
    },
    forkedFrom: { type: "node", nodeId: "synthetic-app-task" },
  });
  put("runs", "synthetic-child-run", {
    threadId: "synthetic-child",
    ordinal: 1,
    status: "running",
    delegatedTaskId: "synthetic-app-task",
  });
  put("subagents", "synthetic-app-task", {
    origin: "app_owned",
    childThreadId: "synthetic-child",
    status: "idle",
    result: null,
    completionDelivery: { state: "claimed", observedByRunId: null },
  });
  put("subagents", "synthetic-remote-task", {
    origin: "app_owned",
    childThreadId: null,
    status: "running",
    remoteChild: {
      environmentId: "synthetic-remote",
      threadId: "synthetic-remote-thread",
      label: "Synthetic remote",
      stoppedThere: false,
    },
  });
  put("subagents", "synthetic-finished-remote-task", {
    origin: "app_owned",
    childThreadId: null,
    status: "completed",
    result: "Synthetic finished result",
    completionDelivery: { state: "disposed", observedByRunId: null },
    remoteChild: {
      environmentId: "synthetic-remote",
      threadId: "synthetic-old-thread",
      label: "Synthetic finished remote",
      stoppedThere: false,
    },
  });
  put("threads", "synthetic-deleted", {
    pullRequests: [],
    deletedAt: at,
    guestShare: null,
    titleRegeneration: null,
    rollbackRequestId: undefined,
    limitRecovery: null,
  });
  put("runs", "synthetic-deleted-run", {
    threadId: "synthetic-deleted",
    ordinal: 1,
    status: "running",
  });
  put("messages", "synthetic-deleted-message", {
    threadId: "synthetic-deleted",
    runId: "synthetic-deleted-run",
    text: "Synthetic deleted history",
  });
  db.exec(`INSERT INTO orchestration_v2_effect_outbox(effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,lease_owner,lease_expires_at,created_at,updated_at)
    VALUES('synthetic-retired-effect','synthetic-command','synthetic-deleted','thread-report.check','{"type":"thread-report.check"}','running',1,'2026-01-01T00:00:00.000Z','synthetic-owner','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
  const witnesses = JSON.parse(
    NodeZlib.gunzipSync(
      NodeFS.readFileSync(new URL("./fixtures/compatibility.json.gz", import.meta.url)),
    ).toString(),
  ) as { shapes: { name: string; value: Record<string, unknown> }[] };
  const task = witnesses.shapes.find((s) => s.name === "column.ScheduledTask")!.value;
  const request = witnesses.shapes.find((s) => s.name === "column.WebhookRequest")!.value;
  for (const effect of [
    {
      type: "checkpoint.capture",
      runId: "run-alpha",
      scopeId: String(
        (
          JSON.parse(
            String(
              db
                .prepare(
                  "SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes LIMIT 1",
                )
                .get()!.payload_json,
            ),
          ) as Record<string, unknown>
        ).id,
      ),
    },
    { type: "attachment.cleanup", attachmentIds: ["synthetic-attachment"] },
    { type: "thread-title.generate", kind: { type: "initial", messageId: "message-alpha" } },
  ])
    db.prepare(
      "INSERT INTO orchestration_v2_effect_outbox(effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at) VALUES(?,?,'ordinary',?,?,'pending',0,?,?,?)",
    ).run(
      "synthetic-loss-" + effect.type,
      "synthetic-loss-" + effect.type,
      effect.type,
      JSON.stringify(effect),
      at,
      at,
      at,
    );
  const types = new Set<string>();
  for (const shape of witnesses.shapes) {
    if (
      shape.name !== "projection.TurnItemJson" ||
      typeof shape.value.type !== "string" ||
      shape.value.type === "user_message" ||
      types.has(shape.value.type)
    )
      continue;
    types.add(shape.value.type);
    put("turn_items", "synthetic-item-" + shape.value.type, {
      ...shape.value,
      threadId: "ordinary",
      runId: "run-alpha",
      nodeId: null,
      ordinal: 200 + types.size,
      status: "running",
      completedAt: null,
    });
  }
  for (const state of ["missing", "stale"]) {
    const threadId = "synthetic-limit-" + state;
    const runId = "synthetic-limit-run-" + state;
    put("threads", threadId, {
      guestShare: null,
      pullRequests: [],
      titleRegeneration: null,
      rollbackRequestId: undefined,
      limitRecovery:
        state === "missing"
          ? undefined
          : { runId: "synthetic-old-run", resetAt: at, autoResume: false },
    });
    put("runs", runId, {
      threadId,
      ordinal: 1,
      status: "failed",
      rootNodeId: null,
      completedAt: at,
    });
    put("turn_items", "synthetic-limit-error-" + state, {
      threadId,
      runId,
      nodeId: null,
      ordinal: 1,
      type: "error",
      status: "failed",
      failure: {
        class: "usage_limit",
        message: "Synthetic usage limit",
        code: null,
        retryable: true,
        resetAt: "2027-01-01T00:00:00.000Z",
      },
    });
  }
  const taskId = String(db.prepare("SELECT task_id FROM scheduled_tasks LIMIT 1").get()!.task_id);
  const interrupted = {
    ...db.prepare("SELECT * FROM scheduled_tasks LIMIT 1").get()!,
    task_id: "synthetic-running-schedule",
    last_run_status: "running",
    last_run_at: at,
    run_count: 0,
  };
  db.prepare(
    `INSERT INTO scheduled_tasks(${Object.keys(interrupted).join(",")}) VALUES(${Object.keys(
      interrupted,
    )
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(interrupted));
  for (const state of ["pending", "dispatching", "running"]) {
    db.prepare(
      `INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json) VALUES (?,?,'2026-01-01T00:00:00.000Z','POST','','{}','',0,0,'accepted',0,'[]')`,
    ).run("synthetic-delivery-" + state, taskId);
    db.prepare(
      `INSERT INTO scheduled_task_webhook_pending(delivery_id,task_id,coalesce_key,due_at,state,task_json,request_json,delivery_ids_json) VALUES(?,?,?,4070908800000,?,?,?,?)`,
    ).run(
      "synthetic-delivery-" + state,
      taskId,
      "synthetic-window-" + state,
      state,
      JSON.stringify({ ...task, id: taskId }),
      JSON.stringify(request),
      JSON.stringify(["synthetic-delivery-" + state]),
    );
  }
  db.prepare(
    "UPDATE scheduled_tasks SET last_run_status='running',last_run_at=?,last_run_webhook_delivery_id='synthetic-delivery-running',run_count=7 WHERE task_id=?",
  ).run(at, taskId);
  db.exec(
    "UPDATE scheduled_tasks SET webhook_token='synthetic-webhook-token-'||task_id,webhook_secret='synthetic-webhook-secret'",
  );
  db.exec(`UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT max(sequence) FROM orchestration_events);
    INSERT OR REPLACE INTO orchestration_v2_turn_item_positions(thread_id,turn_item_id,ordinal) SELECT thread_id,turn_item_id,ordinal FROM orchestration_v2_projection_turn_items;`);
  return put;
}

const proveAutomaticWorkers = Effect.fn("NeutraliseTest.proveAutomaticWorkers")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const attempted = vi.fn(() => Effect.die("unexpected-automatic-work"));
  const automatic = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.never,
      autoArmLimitRecovery: attempted,
      dispatch: attempted,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({ dispatch: attempted }),
    Layer.mock(Scheduler.Scheduler)({ register: (_name, work) => Effect.orDie(work) }),
  );
  yield* Effect.void.pipe(Effect.provide(UsageRecovery.layer.pipe(Layer.provide(automatic))));
  expect(attempted).not.toHaveBeenCalled();
  expect(
    yield* projections.getLimitRecoveryCandidates({
      now: yield* DateTime.now,
      autoResume: true,
      snooze: true,
    }),
  ).toEqual([]);
  {
    const hostRead = vi.fn(() => Effect.die("unexpected-host-read"));
    yield* Effect.gen(function* () {
      yield* (yield* PrWatch.PullRequestWatchReactor).sweep;
    }).pipe(
      Effect.provide(
        PrWatch.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              automatic,
              NodeCryptoServices.layer,
              Layer.mock(PullRequests.PullRequestService)({
                watchFingerprint: hostRead,
                invalidate: hostRead,
                detail: hostRead,
                activity: hostRead,
                threadComments: hostRead,
              }),
            ),
          ),
        ),
      ),
    );
    expect(hostRead).not.toHaveBeenCalled();
    expect(attempted).not.toHaveBeenCalled();
    expect(
      (yield* projections.getThreadsWithPullRequests())
        .flatMap((thread) => thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined),
    ).toEqual([]);
  }
});

function fixture<A, E, R>(
  run: (file: string) => Effect.Effect<A, E, R>,
  setup?: (db: NodeSqlite.DatabaseSync, put: ReturnType<typeof executionFixture>) => void,
  family = "preflight",
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-neutralise-test-"));
      const file = NodePath.join(dir, "source.sqlite");
      NodeFS.writeFileSync(
        file,
        NodeZlib.gunzipSync(
          NodeFS.readFileSync(new URL(`./fixtures/${family}.sqlite.gz`, import.meta.url)),
        ),
      );
      edit(file, (db) => {
        const put = executionFixture(db);
        db.exec(`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json,provider_instance_id)
          VALUES('ordinary','codex','synthetic','full-access','stopped','2026-01-01T00:00:00.000Z','{"threadId":"synthetic-native"}','{}','codex');
          INSERT INTO auth_pairing_links(id,credential,method,scopes,subject,created_at,expires_at)
          VALUES('synthetic-link','synthetic-credential','one-time-token','["orchestration:read"]','synthetic','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
          UPDATE scheduled_tasks SET enabled=1,next_run_at='2099-01-01T00:00:00.000Z',schedule_json='{"type":"once","runAt":"2099-01-01T00:00:00.000Z"}';`);
        db.exec(`INSERT INTO hardware_leases(device_id,thread_id,purpose,token,granted_at,last_activity_at,idle_minutes,hard_expires_at,keep_until_released,release_plan_json,releasing_until) VALUES('synthetic-device','ordinary','synthetic','synthetic-hardware-token','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',5,NULL,0,'[]',NULL);
          UPDATE scheduled_task_webhook_deliveries SET headers_json='{"authorization":"Bearer SYNTHETIC_POISON_HEADER"}';
          INSERT INTO projection_thread_sessions(thread_id,status,provider_name,provider_session_id,provider_thread_id,active_turn_id,updated_at) VALUES('ordinary','stopped','codex','synthetic-old-session','synthetic-old-thread','synthetic-old-turn','2026-01-01T00:00:00.000Z');`);
        db.exec(
          "UPDATE peer_environment_links SET environment_id='synthetic-remote',access='full-access',expires_at='2099-01-01T00:00:00.000Z'",
        );
        setup?.(db, put);
        for (const table of kept)
          expect(Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)).toBeGreaterThan(0);
      });
      return { dir, file };
    }),
    ({ file }) =>
      TestClock.setTime(Date.parse("2026-11-28T00:00:00.000Z")).pipe(Effect.andThen(run(file))),
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
}

function realOrchestrator(file: string, attempted: () => Effect.Effect<never>) {
  return Orchestrator.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CommandPolicy.layer,
        Handoffs.layer,
        Receipts.layer,
        Projects.layer,
        TaskFolders.layer,
        Forks.layer,
        Commands.layer,
        Layer.mock(Checkpoints.CheckpointServiceV2)({
          prepareRootRunScope: (input) =>
            Effect.succeed({
              id: Contracts.CheckpointScopeId.make("synthetic-explicit-scope"),
              threadId: input.threadId,
              runId: input.runId,
              nodeId: input.rootNodeId,
              parentScopeId: null,
              providerThreadId: input.providerThreadId,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: input.cwd,
              createdAt: input.createdAt,
            }),
        }),
        Layer.mock(Adapters.ProviderAdapterRegistryV2)({
          get: (instanceId) =>
            Effect.succeed({
              instanceId,
              driver: Contracts.ProviderDriverKind.make("codex"),
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () => Effect.succeed({ type: "restart_session" }),
              openSession: attempted,
            }),
        }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({ get: () => Effect.succeedNone }),
        Layer.mock(Switch.ProviderSwitchServiceV2)({}),
        Layer.mock(Continuations.ProviderContinuationRequests)({ offer: attempted }),
        Layer.mock(Policy.RuntimePolicyV2)({
          resolve: ({ thread }) =>
            Effect.succeed({
              cwd: NodePath.dirname(file),
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCryptoServices.layer),
  );
}

const proveScheduledStartup = Effect.fn("NeutraliseTest.proveScheduledStartup")(function* (
  mode: "cutover" | "rehearsal",
) {
  const workers = new Map<string, Effect.Effect<void>>();
  const dispatched = vi.fn(() => Effect.die("unexpected-scheduled-dispatch"));
  const dependencies = Layer.mergeAll(
    NodeCryptoServices.layer,
    Layer.succeed(Scheduler.Scheduler, {
      register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
        }),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({ launch: dispatched }),
    Layer.mock(ThreadManagement.ThreadManagementService)({ dispatch: dispatched }),
    Layer.mock(ManagedFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/synthetic",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(Secrets.SecretRequests)({}),
    Layer.succeed(
      ScheduledTasks.ScheduledTaskWebhookOrigin,
      Effect.succeed({ relayHookBaseUrl: null }),
    ),
    ManagedPolicy.layerTest(),
  );
  yield* Effect.gen(function* () {
    yield* ScheduledTasks.ScheduledTaskService;
    yield* workers.get("scheduled-tasks")!;
    const sql = yield* SqlClient.SqlClient;
    const [pending] = yield* sql<{
      n: number;
    }>`SELECT count(*) n FROM scheduled_task_webhook_pending`;
    if (mode === "cutover" && pending!.n > 0) {
      const done = yield* Deferred.make<void>();
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (...args) => {
            end(...args);
            if (span.name === "ScheduledTaskService.dispatchPendingWebhook")
              Deferred.doneUnsafe(done, Effect.void);
          };
          return span;
        },
      });
      yield* workers.get("webhook-coalescing")!.pipe(Effect.withTracer(tracer));
      yield* Deferred.await(done);
    } else yield* workers.get("webhook-coalescing")!;
    expect(yield* sql`SELECT delivery_id FROM scheduled_task_webhook_pending`).toEqual([]);
    expect(yield* ScheduledTasks.listDueTasks(yield* DateTime.now)).toEqual([]);
    expect(dispatched).not.toHaveBeenCalled();
  }).pipe(Effect.provide(ScheduledTasks.layer.pipe(Layer.provide(dependencies))));
});

const proveBootPaths = Effect.fn("NeutraliseTest.proveBootPaths")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const before = yield* sql`SELECT count(*) n FROM orchestration_events`;
  const effects = yield* sql`SELECT count(*) n FROM orchestration_v2_effect_outbox`;
  const heldBefore = yield* projections.getHeldQueuedRuns(Contracts.ThreadId.make("ordinary"));
  expect(heldBefore.length).toBeGreaterThan(0);
  expect(yield* orchestrator.resumeQueuedRuns).toBe(0);
  yield* orchestrator.recoverDelegatedTasks;
  const threads = yield* sql<{
    thread_id: string;
    project_id: string;
  }>`SELECT thread_id,project_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL`;
  expect(
    yield* ProviderRecovery.listContinuableThreadIds(
      threads.map((row) => ({
        id: Contracts.ThreadId.make(row.thread_id),
        projectId: Contracts.ProjectId.make(row.project_id),
      })),
    ),
  ).toEqual(new Set());
  expect(
    (yield* (yield* ProviderRecovery.ProviderRuntimeRecoveryService).reconcile("startup"))
      .terminalizedRuns,
  ).toBe(0);
  for (const run of heldBefore)
    expect(yield* orchestrator.restartContinuationPending(run)).toBe(false);
  yield* Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const initial = yield* Deferred.make<void>();
    const ticked = yield* Deferred.make<void>();
    let calls = 0;
    yield* scheduler.register(
      "copied-held-queue",
      orchestrator.resumeQueuedRuns.pipe(
        Effect.flatMap((resumed) => {
          expect(resumed).toBe(0);
          return Deferred.succeed(++calls === 1 ? initial : ticked, undefined);
        }),
      ),
    );
    yield* Deferred.await(initial);
    yield* TestClock.adjust("5 seconds");
    yield* Deferred.await(ticked);
  }).pipe(Effect.provide(Scheduler.layer), Effect.scoped);
  expect(yield* projections.getHeldQueuedRuns(Contracts.ThreadId.make("ordinary"))).toEqual(
    heldBefore,
  );
  const handoffs = yield* projections.getThreadRecords(Contracts.ThreadId.make("ordinary"), [
    "contextHandoffs",
  ]);
  expect(handoffs.contextHandoffs.find((h) => h.id === "synthetic-deferred-handoff")?.status).toBe(
    "pending",
  );
  expect(yield* sql`SELECT count(*) n FROM orchestration_events`).toEqual(before);
  expect(yield* sql`SELECT count(*) n FROM orchestration_v2_effect_outbox`).toEqual(effects);
});

const proveRemoteFollower = Effect.fn("NeutraliseTest.proveRemoteFollower")(function* (
  mode: "cutover" | "rehearsal",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const finished = yield* Deferred.make<void>();
  const stopped = vi.fn();
  const network = vi.fn(() => Effect.die("unexpected-peer-network"));
  const forbidden = vi.fn(() => Effect.die("unexpected-remote-collection-or-send"));
  const environment = Layer.mock(Environment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(Contracts.EnvironmentId.make("synthetic-here")),
  });
  const links = PeerLinks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environment,
        NodeCryptoServices.layer,
        Layer.mock(SecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
        Layer.succeed(HttpClient.HttpClient, HttpClient.make(network)),
      ),
    ),
  );
  const client = PeerClient.layer.pipe(
    Layer.provideMerge(links),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(network))),
  );
  yield* Effect.gen(function* () {
    const peers = yield* PeerClient.PeerMcpClient;
    const storedLinks = yield* PeerLinks.PeerLinks;
    expect(
      Option.isSome(yield* storedLinks.get(Contracts.EnvironmentId.make("synthetic-remote"))),
    ).toBe(mode === "cutover");
    const follower = Remote.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          environment,
          NodeCryptoServices.layer,
          Layer.succeed(PeerLinks.PeerLinks, storedLinks),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(RepositoryIdentity.RepositoryIdentityResolver)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: (id, fields, filter) =>
              projections.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
            getThreadEventSequence: () => sink.latestSequence().pipe(Effect.orDie),
            streamDomainEvents: orchestrator.streamDomainEvents,
            streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
            dispatch: (command) =>
              orchestrator
                .dispatch(command)
                .pipe(
                  Effect.tap(() =>
                    command.type === "delegated_task.remote.complete"
                      ? Deferred.succeed(finished, undefined)
                      : Effect.void,
                  ),
                ),
          }),
          Layer.mock(Forwarding.PeerForwarding)({
            waitForThread: forbidden,
            readThread: forbidden,
            call: forbidden,
            interruptThread: (_scope, environmentId, input) =>
              mode === "cutover"
                ? Effect.sync(() => {
                    stopped(input);
                    return {
                      threadId: input.threadId,
                      runId: null,
                      status: "no_active_run" as const,
                    };
                  })
                : peers.call({
                    environmentId,
                    tool: "t3_thread_interrupt",
                    arguments: { ...input },
                    limits: { runtimeMode: "full-access", interactionMode: "default" },
                    success: Contracts.OrchestratorMcpThreadInterruptResult,
                  }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const original = (yield* projections.getThreadRecords(Contracts.ThreadId.make("ordinary"), [
        "subagents",
      ])).subagents.find((t) => t.id === "synthetic-remote-task")!;
      expect(original.remoteChild?.stoppedThere).toBe(false);
      expect(original.completionDelivery?.state).toBe("disposed");
      const effects =
        yield* (yield* SqlClient.SqlClient)`SELECT count(*) n FROM orchestration_v2_effect_outbox`;
      yield* (yield* Remote.RemoteDelegation).start();
      yield* Deferred.await(finished);
      expect(
        yield* (yield* SqlClient.SqlClient)`SELECT count(*) n FROM orchestration_v2_effect_outbox`,
      ).toEqual(effects);
      expect(network).not.toHaveBeenCalled();
      expect(forbidden).not.toHaveBeenCalled();
      if (mode === "cutover") {
        expect(stopped).toHaveBeenCalledOnce();
        expect(stopped.mock.calls[0]![0].stop).toBe(true);
      } else expect(stopped).not.toHaveBeenCalled();
    }).pipe(Effect.provide(follower));
  }).pipe(Effect.provide(client), Effect.scoped);
});

it.effect.each([
  ["cutover", "preflight"],
  ["rehearsal", "preflight"],
  ["cutover", "installed-history"],
  ["rehearsal", "installed-history"],
] as const)(
  "settles the synthetic %s %s source before migration and keeps it inert through recovery and replay",
  ([mode, family]) =>
    fixture(
      (file) =>
        Effect.gen(function* () {
          const preserved =
            mode === "cutover"
              ? [...kept]
              : [
                  "projection_projects",
                  "projection_thread_messages",
                  "orchestration_v2_projection_messages",
                ];
          if (family === "installed-history") preserved.push("styal_legacy_v1_rederived_items");
          const keptBefore = hash(file, preserved, true);
          const census = yield* preflight(file);
          expect(census.verdict).toBe("ready");
          yield* archive(file);
          const report = yield* neutralise(file, mode);
          expect(report.impact).toMatchObject({
            "remote-children-still-running": 1,
            "pr-watches-ended": 1,
            "accepted-webhooks-failed": 3,
          });
          for (const key of [
            "checkpoint-captures-cancelled",
            "attachment-cleanups-cancelled",
            "placeholder-titles-cancelled",
          ])
            expect(Number(report.impact[key])).toBeGreaterThan(0);
          const intact = yield* archive(file, true);
          expect(intact.archiveIntact).toBe(true);
          expect(hash(file, preserved, true)).toBe(keptBefore);
          expect((yield* neutralise(file, mode, true)).live).toEqual({});
          edit(file, (db) => {
            expect(
              db
                .prepare(
                  "SELECT count(*) n FROM orchestration_v2_projection_runs WHERE status='cancelled' AND (json_type(payload_json,'$.queueHeld') IS NOT NULL OR json_type(payload_json,'$.steerWhenReadyRunId') IS NOT NULL OR json_type(payload_json,'$.restartContinuationOfRunId') IS NOT NULL)",
                )
                .get()!.n,
            ).toBe(0);
            expect(
              db
                .prepare("SELECT count(*) n FROM scheduled_tasks WHERE last_run_status='running'")
                .get()!.n,
            ).toBe(0);
            expect(
              db
                .prepare(
                  "SELECT run_count FROM scheduled_tasks WHERE task_id='synthetic-running-schedule'",
                )
                .get()!.run_count,
            ).toBe(1);
            expect(
              db
                .prepare(
                  "SELECT run_count FROM scheduled_tasks WHERE last_run_webhook_delivery_id='synthetic-delivery-running'",
                )
                .get()!.run_count,
            ).toBe(7);
            for (const definition of source.definitions.filter(
              (d) =>
                d.type === "table" &&
                d.columns.some((c) => c.name === "status") &&
                d.columns.some((c) => c.name === "payload_json") &&
                d.name.startsWith("orchestration_v2_projection_"),
            ))
              expect(
                db
                  .prepare(
                    `SELECT count(*) n FROM ${definition.name} WHERE status IS NOT json_extract(payload_json,'$.status')`,
                  )
                  .get()!.n,
              ).toBe(0);
            expect(
              db
                .prepare(
                  "SELECT count(*) n FROM scheduled_task_webhook_pending WHERE state IN ('pending','dispatching','running')",
                )
                .get()!.n,
            ).toBe(0);
            expect(
              db
                .prepare(
                  "SELECT count(*) n FROM scheduled_task_webhook_pending WHERE state='failed'",
                )
                .get()!.n,
            ).toBe(mode === "cutover" ? 3 : 0);
            expect(
              db
                .prepare(
                  "SELECT count(*) n FROM orchestration_v2_projection_provider_threads WHERE json_extract(payload_json,'$.nativeThreadRef.nativeId')='synthetic-live-session'",
                )
                .get()!.n,
            ).toBe(mode === "cutover" ? 1 : 0);
          });
          const firstHash = hash(
            file,
            source.definitions.filter((d) => d.type === "table").map((d) => d.name),
          );
          const repeated = yield* neutralise(file, mode);
          expect(repeated.changed).toEqual({});
          expect(repeated.impact).toEqual(report.impact);
          expect(
            hash(
              file,
              source.definitions.filter((d) => d.type === "table").map((d) => d.name),
            ),
          ).toBe(firstHash);

          const sqlite = NodeSqliteClient.layer({
            filename: file,
            readerWorker: false,
            writerWorker: false,
          });
          const stores = Layer.mergeAll(
            ProjectionReplay.layer,
            EventSink.layer,
            Maintenance.layer,
          ).pipe(
            Layer.provideMerge(
              Layer.mergeAll(ProjectionStore.layer, EventStore.layer, EffectOutbox.layer),
            ),
            Layer.provideMerge(sqlite),
          );
          const attempted = vi.fn(() => Effect.die("unexpected-provider-or-continuation"));
          yield* Effect.gen(function* () {
            yield* runAllMigrations();
            yield* TestClock.setTime(Date.parse("2027-01-01T00:00:01.000Z"));
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const sql = yield* SqlClient.SqlClient;
            expect(yield* sql`SELECT mode FROM styal_neutralisation`).toEqual([{ mode }]);
            for (const kind of [
              "runtime",
              "queued-runs",
              "restart-continuations",
              "subagent-results",
              "delegated-completions",
              "unread-steers",
            ] as const)
              if (kind === "queued-runs") {
                for (const id of yield* projections.getRecoveryThreadIds(kind))
                  expect(yield* projections.canStartQueuedRun(id)).toBe(false);
              } else expect(yield* projections.getRecoveryThreadIds(kind), kind).toEqual([]);
            expect((yield* outbox.claimNext({ workerId: "synthetic-worker" }))._tag).toBe("None");
            const before = yield* sql`SELECT count(*) n FROM orchestration_events`;
            const outboxBefore = yield* sql`SELECT count(*) n FROM orchestration_v2_effect_outbox`;
            const recovered = yield* (yield* ProviderRecovery.ProviderRuntimeRecoveryService)
              .recover;
            expect(recovered).toEqual({
              terminalizedRuns: 0,
              stoppedSessions: 0,
              closedRequests: 0,
              retiredEffects: 0,
              requeuedEffects: 0,
            });
            expect(yield* sql`SELECT count(*) n FROM orchestration_events`).toEqual(before);
            expect(yield* sql`SELECT count(*) n FROM orchestration_v2_effect_outbox`).toEqual(
              outboxBefore,
            );
            yield* proveAutomaticWorkers();
            yield* proveBootPaths();
            yield* proveScheduledStartup(mode);
            yield* proveRemoteFollower(mode);
            const replayed = yield* (yield* ProjectionReplay.ProjectionReplay).rebuild;
            expect(replayed.valid, JSON.stringify(replayed)).toBe(true);
            yield* proveAutomaticWorkers();
            yield* proveBootPaths();
            yield* proveScheduledStartup(mode);
            for (const kind of [
              "runtime",
              "queued-runs",
              "restart-continuations",
              "subagent-results",
              "delegated-completions",
              "unread-steers",
            ] as const)
              if (kind === "queued-runs") {
                for (const id of yield* projections.getRecoveryThreadIds(kind))
                  expect(yield* projections.canStartQueuedRun(id)).toBe(false);
              } else expect(yield* projections.getRecoveryThreadIds(kind), kind).toEqual([]);
            for (const { thread_id } of yield* sql<{
              thread_id: string;
            }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL`) {
              const shell = yield* projections.getThreadShell(Contracts.ThreadId.make(thread_id));
              expect(["preparing", "starting", "running", "waiting"]).not.toContain(shell?.status);
              expect(shell?.pendingBackgroundTasks).toEqual([]);
              expect(shell?.pendingRuntimeRequest).toBeNull();
            }
            const projection = yield* projections.getThreadProjection(
              Contracts.ThreadId.make("ordinary"),
            );
            expect(
              projection.turnItems.some(
                (item) => item.type === "user_message" && item.text === "Synthetic queued input",
              ),
            ).toBe(true);
            expect(
              (yield* projections.getHeldQueuedRuns(Contracts.ThreadId.make("ordinary"))).map(
                (run) => run.id,
              ),
            ).toContain("synthetic-run-queued");
            expect(
              projection.turnItems.some(
                (item) => item.type === "system_notice" && item.title === "Server restarted",
              ),
            ).toBe(true);
            expect(
              yield* projections.hasPendingDelegatedCompletion(
                Contracts.ThreadId.make("synthetic-child"),
              ),
            ).toBe(false);
            expect(
              yield* (yield* Maintenance.ProjectionMaintenanceV2).purgeDeletedThread(
                Contracts.ThreadId.make("synthetic-deleted"),
              ),
            ).toBeGreaterThan(0);
            expect(attempted).not.toHaveBeenCalled();
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator.dispatch({
              type: "queue.resume",
              threadId: Contracts.ThreadId.make("ordinary"),
              commandId: Contracts.CommandId.make("synthetic-explicit-queue-resume"),
            });
            const afterUser = yield* projections.getThreadRecords(
              Contracts.ThreadId.make("ordinary"),
              ["runs", "turnItems"],
            );
            expect(
              afterUser.runs.find((r) => r.id === "synthetic-run-queued")?.status,
              JSON.stringify(afterUser.turnItems.filter((item) => item.type === "error")),
            ).toBe("starting");
            expect(
              yield* projections.getHeldQueuedRuns(Contracts.ThreadId.make("ordinary")),
            ).toEqual([]);
            expect(
              (yield* sql<{
                n: number;
              }>`SELECT count(*) n FROM orchestration_v2_effect_outbox WHERE status='pending' AND effect_type='provider-turn.start'`)[0]!
                .n,
            ).toBeGreaterThan(0);
            expect(attempted).not.toHaveBeenCalled();
          }).pipe(
            Effect.provide(realOrchestrator(file, attempted)),
            Effect.provide(
              ProviderRecovery.layer.pipe(
                Layer.provideMerge(
                  Layer.mergeAll(
                    IdAllocator.layer,
                    Settings.layerTest({
                      continueThreadsAfterServerUpdate: true,
                      autoResumeLimitedThreads: true,
                      snoozeLimitedThreads: true,
                    }),
                  ),
                ),
                Layer.provideMerge(stores),
              ),
            ),
            Effect.scoped,
          );
          expect((yield* archive(file, true)).archiveIntact).toBe(true);
        }),
      undefined,
      family,
    ),
);

it.effect(
  "cutover keeps every settled projection row byte-identical and leaves old null results unreported on boot",
  () =>
    fixture(
      (file) =>
        Effect.gen(function* () {
          const history = terminalRows(file);
          expect(history.length).toBeGreaterThan(0);
          yield* archive(file);
          yield* neutralise(file, "cutover");
          expectTerminalRows(file, history);
          edit(file, (db) => {
            for (const id of [
              "synthetic-history-owner",
              "synthetic-history-open-owner",
              "synthetic-history-null-task",
              "synthetic-history-link_request",
              "synthetic-history-feedback_request",
              "synthetic-history-secret_request",
              "synthetic-history-handoff",
            ])
              expect(
                db
                  .prepare(
                    "SELECT count(*) n FROM orchestration_events WHERE sequence>? AND json_extract(payload_json,'$.id')=?",
                  )
                  .get(
                    Number(
                      db
                        .prepare(
                          "SELECT max(sequence) n FROM orchestration_events WHERE event_id LIKE 'event:synthetic:%'",
                        )
                        .get()!.n,
                    ),
                    id,
                  )!.n,
              ).toBe(0);
          });

          const sqlite = NodeSqliteClient.layer({
            filename: file,
            readerWorker: false,
            writerWorker: false,
          });
          const stores = Layer.mergeAll(EventSink.layer, ProjectionReplay.layer).pipe(
            Layer.provideMerge(
              Layer.mergeAll(ProjectionStore.layer, EventStore.layer, EffectOutbox.layer),
            ),
            Layer.provideMerge(sqlite),
          );
          const attempted = vi.fn(() => Effect.die("unexpected-history-provider-work"));
          yield* Effect.gen(function* () {
            yield* runAllMigrations();
            const sql = yield* SqlClient.SqlClient;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            for (const replay of [false, true]) {
              if (replay)
                expect((yield* (yield* ProjectionReplay.ProjectionReplay).rebuild).valid).toBe(
                  true,
                );
              const before = terminalRows(file);
              const effects = yield* sql`SELECT count(*) n FROM orchestration_v2_effect_outbox`;
              const events = yield* sql`SELECT count(*) n FROM orchestration_events`;
              yield* orchestrator.recoverDelegatedTasks;
              expect(yield* orchestrator.resumeQueuedRuns).toBe(0);
              expect(yield* sql`SELECT count(*) n FROM orchestration_events`).toEqual(events);
              expect(yield* sql`SELECT count(*) n FROM orchestration_v2_effect_outbox`).toEqual(
                effects,
              );
              expectTerminalRows(file, before);
            }
            expect(attempted).not.toHaveBeenCalled();
          }).pipe(
            Effect.provide(realOrchestrator(file, attempted)),
            Effect.provide(
              Layer.mergeAll(
                stores,
                IdAllocator.layer,
                Settings.layerTest({ continueThreadsAfterServerUpdate: true }),
              ),
            ),
            Effect.scoped,
          );
        }),
      (db, put) => {
        const at = "2026-01-01T00:00:00.000Z";
        db.exec(
          "UPDATE orchestration_v2_projection_runs SET status='waiting',payload_json=json_set(payload_json,'$.status','waiting') WHERE run_id='synthetic-delivery'; UPDATE orchestration_v2_projection_provider_sessions SET status='waiting',payload_json=json_set(payload_json,'$.status','waiting') WHERE status='error' AND json_array_length(payload_json,'$.extensionStatuses')>0",
        );
        put("runs", "synthetic-history-owner", {
          status: "completed",
          ordinal: 500,
          completedAt: at,
          delegatedCompletion: { disposition: "disposed", nextGeneration: 1, delivery: null },
        });
        put("runs", "synthetic-history-open-owner", {
          status: "completed",
          ordinal: 501,
          completedAt: at,
          delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
        });
        put("threads", "synthetic-history-child", {
          pullRequests: [],
          guestShare: null,
          titleRegeneration: null,
          limitRecovery: null,
          rollbackRequestId: undefined,
          lineage: {
            parentThreadId: "ordinary",
            rootThreadId: "ordinary",
            relationshipToParent: "subagent",
          },
          forkedFrom: { type: "node", nodeId: "synthetic-history-null-task" },
        });
        put("runs", "synthetic-history-child-run", {
          threadId: "synthetic-history-child",
          status: "completed",
          ordinal: 1,
          completedAt: at,
          delegatedTaskId: "synthetic-history-null-task",
        });
        put("subagents", "synthetic-history-null-task", {
          runId: "synthetic-history-owner",
          origin: "app_owned",
          childThreadId: "synthetic-history-child",
          remoteChild: undefined,
          status: "cancelled",
          completedAt: at,
          result: null,
          cancelledRunId: "synthetic-history-child-run",
          completionDelivery: { state: "disposed", observedByRunId: null },
        });
        put("runs", "synthetic-history-followup-run", {
          threadId: "synthetic-history-child",
          status: "completed",
          ordinal: 2,
          startedAt: at,
          completedAt: at,
          delegatedTaskId: "synthetic-history-followup-task",
        });
        put("subagents", "synthetic-history-followup-task", {
          runId: "synthetic-history-open-owner",
          origin: "app_owned",
          childThreadId: "synthetic-history-child",
          remoteChild: undefined,
          status: "cancelled",
          completedAt: at,
          result: null,
          completionDelivery: undefined,
        });
        put("runs", "synthetic-history-other-result", {
          threadId: "synthetic-history-child",
          status: "completed",
          ordinal: 3,
          startedAt: at,
          completedAt: at,
          delegatedTaskId: undefined,
        });
        put("context_transfers", "synthetic-history-other-transfer", {
          type: "subagent_result",
          sourceThreadId: "synthetic-history-child",
          targetThreadId: "ordinary",
          sourcePoint: {
            threadId: "synthetic-history-child",
            runId: "synthetic-history-other-result",
          },
          targetRunId: null,
          status: "consumed",
          resolution: null,
          consumedAt: at,
        });
        put("messages", "synthetic-history-held-message", {
          threadId: "synthetic-history-child",
          runId: "synthetic-history-held-run",
          role: "user",
          createdBy: "user",
          creationSource: "web",
          delegatedCompletion: undefined,
          notification: undefined,
          scheduledTaskId: undefined,
        });
        put("runs", "synthetic-history-held-run", {
          threadId: "synthetic-history-child",
          status: "queued",
          ordinal: 4,
          userMessageId: "synthetic-history-held-message",
          rootNodeId: null,
          activeAttemptId: null,
          startedAt: null,
          completedAt: null,
          delegatedTaskId: "synthetic-history-followup-task",
          queueHeld: false,
        });
        put("runs", "synthetic-history-unaccepted-run", {
          threadId: "synthetic-history-child",
          status: "starting",
          ordinal: 5,
          rootNodeId: null,
          activeAttemptId: null,
          startedAt: null,
          completedAt: null,
          delegatedTaskId: "synthetic-history-followup-task",
        });
        const witnesses = JSON.parse(
          NodeZlib.gunzipSync(
            NodeFS.readFileSync(new URL("./fixtures/compatibility.json.gz", import.meta.url)),
          ).toString(),
        ) as { shapes: { name: string; value: Record<string, unknown> }[] };
        for (const [index, type] of [
          "link_request",
          "feedback_request",
          "secret_request",
        ].entries()) {
          const shape =
            type === "feedback_request"
              ? {
                  type: "feedback_request",
                  preview: {
                    kind: "bug",
                    subject: "Synthetic history",
                    expected: "Synthetic expectation",
                    actual: "Synthetic observation",
                    workaround: "",
                    trace: null,
                  },
                  feedbackStatus: "pending",
                }
              : witnesses.shapes.find(
                  (s) => s.name === "projection.TurnItemJson" && s.value.type === type,
                )!.value;
          put("turn_items", "synthetic-history-" + type, {
            ...shape,
            threadId: "ordinary",
            runId: "synthetic-history-owner",
            nodeId: null,
            status: "completed",
            ordinal: 600 + index,
            completedAt: at,
            ...(type === "link_request"
              ? { linkStatus: "pending" }
              : type === "feedback_request"
                ? { feedbackStatus: "pending" }
                : { secretStatus: "pending" }),
          });
        }
        put("context_handoffs", "synthetic-history-handoff", {
          status: "ready",
          targetRunId: "synthetic-history-owner",
          delivery: { nativeThreadId: "synthetic-history-native", status: "injected", itemIds: [] },
        });
        db.exec(
          "UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT max(sequence) FROM orchestration_events)",
        );
      },
    ),
);

it.effect("refuses undecodable schedules with a specific private category and rolls back", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* archive(file);
      const tables = source.definitions.filter((d) => d.type === "table").map((d) => d.name);
      const before = hash(file, tables);
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      const injected = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync, sql: string) {
          const statement = prepare.call(this, sql);
          if (sql.startsWith("SELECT rowid AS row_id,*,EXISTS(")) {
            const rows = statement.all();
            statement.all = () =>
              rows.map((row) => ({
                ...row,
                schedule_json: '{"type":"SYNTHETIC_POISON_SCHEDULE"}',
              }));
          }
          return statement;
        });
      let result;
      try {
        result = yield* Effect.result(neutralise(file, "cutover"));
      } finally {
        injected.mockRestore();
      }
      expect(Result.isFailure(result) ? result.failure.category : "success").toBe(
        "schedule-undecodable",
      );
      expect(hash(file, tables)).toBe(before);
    }),
  ),
);

it.effect("rehearsal removes external identity and resume state and cannot become a cutover", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* archive(file);
      expect((yield* neutralise(file, "rehearsal")).mode).toBe("rehearsal");
      edit(file, (db) => {
        for (const table of [
          "auth_sessions",
          "auth_pairing_links",
          "peer_environment_links",
          "provider_session_runtime",
        ])
          expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM scheduled_tasks WHERE enabled<>0 OR next_run_at IS NOT NULL OR webhook_token IS NOT NULL OR webhook_secret IS NOT NULL",
            )
            .get()!.n,
        ).toBe(0);
        expect(db.prepare("SELECT count(*) n FROM scheduled_task_webhook_pending").get()!.n).toBe(
          0,
        );
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM orchestration_v2_projection_provider_threads WHERE provider_session_id IS NOT NULL OR json_type(payload_json,'$.nativeThreadRef')<>'null'",
            )
            .get()!.n,
        ).toBe(0);
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM scheduled_task_webhook_deliveries WHERE headers_json<>'{}'",
            )
            .get()!.n,
        ).toBe(0);
        expect(db.prepare("SELECT count(*) n FROM hardware_leases WHERE token<>''").get()!.n).toBe(
          0,
        );
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM projection_thread_sessions WHERE provider_session_id IS NOT NULL OR provider_thread_id IS NOT NULL OR active_turn_id IS NOT NULL",
            )
            .get()!.n,
        ).toBe(0);
        for (const [kind, fields] of Object.entries({
          run_attempts: ["nativeThreadId"],
          provider_turns: ["nativeThreadRef", "nativeTurnRef"],
          nodes: ["nativeItemRef"],
          runtime_requests: ["nativeRequestRef"],
          subagents: ["nativeTaskRef"],
          turn_items: ["nativeItemRef"],
        }))
          for (const field of fields)
            expect(
              db
                .prepare(
                  `SELECT count(*) n FROM orchestration_v2_projection_${kind} WHERE json_extract(payload_json,'$.${field}') IS NOT NULL`,
                )
                .get()!.n,
            ).toBe(0);
        expect(
          db.prepare("SELECT format_version FROM styal_neutralisation").get()!.format_version,
        ).toBe(2);
      });
      expect((yield* neutralise(file, "rehearsal")).changed).toEqual({});
      const cutover = yield* Effect.result(neutralise(file, "cutover"));
      expect(Result.isFailure(cutover) ? cutover.failure.category : "success").toBe(
        "neutralisation-mode-mismatch",
      );
      expect((yield* archive(file, true)).archiveIntact).toBe(true);
    }),
  ),
);

it.effect(
  "stops streaming while preserving message bytes and untouched historical number tokens",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        edit(file, (db) => {
          db.exec(`UPDATE orchestration_v2_projection_messages SET streaming=1,payload_json=json_set(payload_json,'$.streaming',json('true'));
      UPDATE orchestration_v2_projection_provider_turns SET payload_json=json_set(payload_json,'$.turnTokenUsage.costUsd',json('12345678901234567891'));`);
        });
        const content = () => {
          let digest = "";
          edit(file, (db) => {
            digest = NodeCrypto.createHash("sha256")
              .update(
                JSON.stringify(
                  db
                    .prepare(
                      "SELECT message_id,hex(CAST(json_extract(payload_json,'$.text') AS BLOB)) AS text,hex(CAST(json_extract(payload_json,'$.attachments') AS BLOB)) AS attachments FROM orchestration_v2_projection_messages ORDER BY message_id",
                    )
                    .all(),
                ),
              )
              .digest("hex");
          });
          return digest;
        };
        const before = content();
        yield* archive(file);
        yield* neutralise(file, "cutover");
        expect(content()).toBe(before);
        edit(file, (db) => {
          expect(
            db
              .prepare(
                "SELECT count(*) n FROM orchestration_v2_projection_messages WHERE streaming<>0 OR json_extract(payload_json,'$.streaming')<>0",
              )
              .get()!.n,
          ).toBe(0);
          expect(
            db
              .prepare(
                "SELECT count(*) n FROM orchestration_v2_projection_provider_turns WHERE instr(payload_json,'12345678901234567891')>0",
              )
              .get()!.n,
          ).toBe(3);
        });
        expect((yield* archive(file, true)).archiveIntact).toBe(true);
      }),
    ),
);

it.effect("refuses a missing or damaged archive without exposing source values", () =>
  fixture((file) =>
    Effect.gen(function* () {
      const missing = yield* Effect.result(neutralise(file, "cutover"));
      expect(Result.isFailure(missing) ? missing.failure.category : "success").toBe(
        "archive-missing",
      );
      yield* archive(file);
      edit(file, (db) => {
        db.exec(
          "UPDATE styal_archive_raw_cells SET raw_text='SYNTHETIC_POISON' WHERE source_table='provider_session_runtime'",
        );
      });
      const damaged = yield* Effect.result(neutralise(file, "cutover"));
      expect(Result.isFailure(damaged) ? damaged.failure.category : "success").toBe(
        "archive-integrity-mismatch",
      );
    }),
  ),
);

it.effect("rolls back earlier rows and appended events when a later write fails", () =>
  fixture((file) =>
    Effect.gen(function* () {
      yield* archive(file);
      const tables = source.definitions.filter((d) => d.type === "table").map((d) => d.name);
      const before = hash(file, tables);
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      const injected = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync, sql: string) {
          if (sql.startsWith("UPDATE orchestration_v2_projection_provider_sessions"))
            throw new Error("SYNTHETIC_POISON_FAILURE");
          return prepare.call(this, sql);
        });
      try {
        const result = yield* Effect.result(neutralise(file, "cutover"));
        expect(Result.isFailure(result) ? result.failure.category : "success").toBe(
          "neutralisation-failed",
        );
      } finally {
        injected.mockRestore();
      }
      expect(hash(file, tables)).toBe(before);
      edit(file, (db) => {
        expect(
          db.prepare("SELECT 1 FROM sqlite_schema WHERE name='styal_neutralisation'").get(),
        ).toBeUndefined();
      });
      expect((yield* archive(file, true)).sourceStillMatches).toBe(true);
    }),
  ),
);

it.effect("CLI requires a mode, refuses the live home, and never prints poisoned cells", () =>
  fixture((file) =>
    Effect.gen(function* () {
      edit(file, (db) => {
        db.exec(
          "UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.restartHeldRunIds',json('[\"SYNTHETIC_POISON_VALUE\"]'))",
        );
      });
      yield* archive(file);
      const cli = (args: string[]) =>
        NodeChildProcess.spawnSync(
          process.execPath,
          [NodePath.join(import.meta.dirname, "neutraliseCli.ts"), ...args],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: NodePath.join(NodePath.dirname(file), "home"),
              STYAL_HOME: NodePath.join(NodePath.dirname(file), "home/.styal"),
              T3CODE_DEV_SEED: "0",
              T3CODE_TELEMETRY_ENABLED: "false",
              DO_NOT_TRACK: "1",
              T3CODE_ERROR_REPORTING_ENABLED: "false",
              T3CODE_PORT: undefined,
            },
          },
        );
      const missingMode = cli([file]);
      expect(missingMode.status).toBe(1);
      expect(missingMode.stderr).toContain("explicit-path-and-mode-required");
      const live = cli([
        NodePath.join(NodeOS.userInfo().homedir, ".styal/synthetic-never-open.sqlite"),
        "cutover",
      ]);
      expect(live.status).toBe(1);
      expect(live.stderr).toContain("live-styal-home-refused");
      const run = cli([file, "cutover"]);
      expect(run.status).toBe(0);
      expect(run.stdout + run.stderr).not.toContain("SYNTHETIC_POISON_VALUE");
      expect(run.stdout + run.stderr).not.toContain("SYNTHETIC_POISON_HEADER");
      expect(run.stdout + run.stderr).not.toContain(file);
      expect(JSON.parse(run.stdout).mode).toBe("cutover");
      const verified = cli([file, "cutover", "--verify"]);
      expect(verified.status).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        mode: "cutover",
        marked: true,
        live: {},
      });
      expect(verified.stdout + verified.stderr).not.toContain("SYNTHETIC_POISON_VALUE");
    }),
  ),
);
