import * as C from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const serverCapability = Schema.Struct({
  type: Schema.Literal("server"),
  attention: Schema.optional(Schema.Literal("input")),
});
export const backgroundCommand = Schema.Struct({
  nativeItemId: C.TrimmedNonEmptyString,
  turnItemId: C.TurnItemId,
  nodeId: C.NodeId,
  threadId: C.ThreadId,
  runId: Schema.NullOr(C.RunId),
  rootNodeId: C.NodeId,
  parentNodeId: C.NodeId,
  providerThreadId: Schema.NullOr(C.ProviderThreadId),
  providerTurnId: Schema.NullOr(C.ProviderTurnId),
  ordinal: C.NonNegativeInt,
  input: Schema.String,
  startedAt: C.TrimmedNonEmptyString,
});
const isServerCapability = Schema.is(serverCapability);
const isBackgroundCommand = Schema.is(backgroundCommand);
const decodeBackgroundTask = Schema.decodeUnknownResult(C.OrchestrationV2PendingBackgroundTask);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const historicalEffectTypes = [
  "thread-report.check",
  "message.mentioned-times.check",
  "delegated-task.wake-timeout",
] as const;
export const isHistoricalEffectType = (type: string) =>
  historicalEffectTypes.some((historical) => historical === type);

export const isHistoricalEventType = (type: string) =>
  type === "legacy-usage.imported" || type === "message.mentioned-times-checked";

export function runtimeRequest(value: unknown): unknown {
  if (
    !object(value) ||
    !isServerCapability(value.responseCapability) ||
    typeof value.status !== "string" ||
    !["pending", "resolved", "expired", "cancelled"].includes(value.status)
  )
    return value;
  return {
    ...value,
    status: value.status === "pending" ? "expired" : value.status,
    resolvedAt:
      value.status === "pending" ? (value.resolvedAt ?? value.createdAt) : value.resolvedAt,
    responseCapability: { type: "not_resumable", reason: "Historical server request" },
  };
}

export function providerThread(value: unknown): unknown {
  if (
    !object(value) ||
    !Array.isArray(value.pendingBackgroundTasks) ||
    value.pendingBackgroundTasks.length === 0
  )
    return value;
  return {
    ...value,
    // Ownership objects belong to the old runtime; never expose them to recovery or waiters.
    pendingBackgroundTasks: value.pendingBackgroundTasks.filter((task: unknown) => {
      if (!object(task) || !isBackgroundCommand(task.command)) return true;
      const { command: _command, ...rest } = task;
      return Result.isFailure(decodeBackgroundTask(rest));
    }),
  };
}

export function projectEvent(value: unknown): unknown {
  if (!object(value) || !object(value.payload)) return value;
  let scripts: unknown = value.payload.scripts;
  if (typeof scripts === "string") {
    try {
      scripts = JSON.parse(scripts);
    } catch {
      return value;
    }
  }
  if (!Array.isArray(scripts)) return value;
  return {
    ...value,
    payload: {
      ...value.payload,
      scripts: scripts.map((script: unknown) =>
        object(script) &&
        typeof script.icon === "string" &&
        ["desktop", "database", "deploy"].includes(script.icon)
          ? { ...script, icon: "play" }
          : script,
      ),
    },
  };
}

export function threadEventPayload(type: string, payload: unknown): unknown {
  return type === "runtime-request.updated"
    ? runtimeRequest(payload)
    : type === "provider-thread.updated"
      ? providerThread(payload)
      : payload;
}

// A removed grant confers no authority in the restart; future unknown grants still fail validation.
export const authScopes = Schema.fromJsonString(Schema.Array(Schema.String)).pipe(
  Schema.decodeTo(
    C.AuthEnvironmentScopes,
    SchemaTransformation.transform({
      decode: (scopes) =>
        scopes.filter(
          (scope) => scope !== "devices:operate",
        ) as typeof C.AuthEnvironmentScopes.Encoded,
      encode: (scopes) => scopes,
    }),
  ),
);

export const runtimeRequestStatus = (
  sql: SqlClient.SqlClient,
  table = "orchestration_v2_projection_runtime_requests",
) => sql`CASE WHEN json_valid(${sql(table)}.payload_json)
  THEN CASE WHEN ${sql(table)}.status = 'pending'
    AND json_extract(${sql(table)}.payload_json, '$.responseCapability.type') = 'server'
    THEN 'expired' ELSE ${sql(table)}.status END
  ELSE ${sql(table)}.status END`;

export const pendingRuntimeRequest = (
  sql: SqlClient.SqlClient,
  table = "orchestration_v2_projection_runtime_requests",
) => sql`${sql(table)}.status = 'pending' AND ${runtimeRequestStatus(sql, table)} = 'pending'`;
