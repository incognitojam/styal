import {
  CheckpointId,
  CheckpointScopeId,
  EventId,
  NodeId,
  ProviderDriverKind,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts/legacy-orchestration";
import { collectToolFilePaths } from "@t3tools/shared/toolActivity";
import { recordedCommandOutput } from "../CommandOutputQuery.ts";
import * as DateTime from "effect/DateTime";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
function historicalStatus(value: unknown, kind: string): OrchestrationV2TurnItemStatus {
  if (value === "failed" || value === "error" || kind.endsWith("failed")) return "failed";
  if (value === "cancelled" || value === "canceled" || kind.endsWith("cancelled"))
    return "cancelled";
  if (
    value === "inProgress" ||
    value === "running" ||
    value === "pending" ||
    kind.endsWith("started")
  )
    return "interrupted";
  return "completed";
}

type LegacyActivity = OrchestrationV2TurnItem["legacyActivities"] extends
  | ReadonlyArray<infer Activity>
  | undefined
  ? Activity
  : never;

/** Items keep a reference to their V1 activity; its payload stays in the V1 source. */
function activityReference({ payload: _payload, ...reference }: LegacyActivity): LegacyActivity {
  return reference;
}

/**
 * Runtime bookkeeping the V1 work log never displayed. Checkpoints import as their own
 * records, usage as legacy turn usage, agent spawns as subagent items, and a setup script
 * as its outcome row. Fork migrations 7 and 9 remove these from earlier imports.
 */
const UNDISPLAYED_ACTIVITY_KINDS = new Set([
  "checkpoint.captured",
  "context-window.updated",
  "setup-script.requested",
  "setup-script.started",
  "task.started",
  "task.updated",
  "tool.progress",
  "tool.started",
  "turn.plan.updated",
  "turn.usage",
  "worktree-setup",
]);

function isUndisplayedActivity(activity: LegacyActivity): boolean {
  // Subagent progress chatter folded into the agent's own row in V1.
  return (
    UNDISPLAYED_ACTIVITY_KINDS.has(activity.kind) ||
    (activity.kind === "task.progress" && record(activity.payload).timelineBypass === true)
  );
}

function notificationSource(
  activity: LegacyActivity,
): Extract<OrchestrationV2TurnItem, { type: "notification" }>["source"] {
  const payload = record(activity.payload);
  if (payload.taskType === "local_agent" || payload.agentKind === "agent") {
    return { kind: "subagent" };
  }
  if (
    payload.taskType === "local_bash" ||
    activity.kind.startsWith("setup-script.") ||
    activity.kind === "command.interaction"
  ) {
    return { kind: "command" };
  }
  return { kind: "background_task" };
}

function notificationOutcome(
  activity: LegacyActivity,
): Extract<OrchestrationV2TurnItem, { type: "notification" }>["outcome"] {
  const status = record(activity.payload).status;
  if (activity.tone === "error" || status === "failed" || activity.kind.endsWith(".failed")) {
    return "failed";
  }
  if (status === "stopped" || status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "completed" || activity.kind.endsWith(".completed")) return "completed";
  return "updated";
}

/** Where a converted group sits; the remaining fields derive from its activities. */
export interface LegacyActivityItemIdentity {
  readonly id: TurnItemId;
  readonly threadId: OrchestrationV2AppThread["id"];
  readonly ordinal: number;
}

/**
 * Converts one V1 activity group other than a subagent spawn, or returns null when the V1
 * work log never displayed it. Imports and fork migration 9 share this conversion.
 */
export function legacyActivityTurnItem(
  identity: LegacyActivityItemIdentity,
  activities: ReadonlyArray<LegacyActivity>,
): OrchestrationV2TurnItem | null {
  if (activities.every(isUndisplayedActivity)) return null;
  const ordered = activities.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = ordered[0];
  const last = ordered.at(-1);
  if (first === undefined || last === undefined) return null;
  // V1 often logged a final in-progress update at the completion's timestamp.
  const terminal = ordered.findLast((activity) => activity.kind === "tool.completed") ?? last;
  const payload = record(terminal.payload);
  const data = record(payload.data);
  const nativeItem = record(data.item);
  const rawInput = record(data.rawInput);
  const base = {
    ...identity,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: historicalStatus(payload.status, terminal.kind),
    title: text(payload.title) ?? terminal.summary,
    startedAt: DateTime.makeUnsafe(first.createdAt),
    completedAt: DateTime.makeUnsafe(last.createdAt),
    updatedAt: DateTime.makeUnsafe(last.createdAt),
    legacyActivities: activities.map(activityReference),
    ...(last.turnId === null ? {} : { legacyTurnId: last.turnId }),
  };
  const type = text(payload.itemType, nativeItem.type);
  if (type === "command_execution" || type === "commandExecution") {
    const command =
      text(
        nativeItem.command,
        record(nativeItem.input).command,
        data.command,
        rawInput.command,
        payload.detail,
      ) ?? last.summary;
    // Providers recorded output in several V1 shapes; read it the way output queries did.
    const recorded = recordedCommandOutput({
      output: text(nativeItem.aggregatedOutput, nativeItem.output, data.output, payload.output),
      exitCode: nativeItem.exitCode ?? data.exitCode,
      legacyActivities: activities.map(activityReference),
    });
    return {
      ...base,
      type: "command_execution",
      input: command,
      ...(recorded.output === null ? {} : { output: recorded.output }),
      ...(recorded.exitCode === null ? {} : { exitCode: recorded.exitCode }),
    };
  } else if (type === "file_change" || type === "fileChange") {
    const fileName =
      text(nativeItem.fileName, nativeItem.path, data.path) ?? collectToolFilePaths(data)[0];
    if (fileName === undefined) {
      return { ...base, type: "dynamic_tool", toolName: "file_change", input: data };
    } else {
      const additions = count(nativeItem.additions ?? data.additions);
      const deletions = count(nativeItem.deletions ?? data.deletions);
      const diffStr = text(nativeItem.diff, nativeItem.diffStr, data.diff);
      return {
        ...base,
        type: "file_change",
        fileName,
        ...(additions === undefined ? {} : { additions }),
        ...(deletions === undefined ? {} : { deletions }),
        ...(diffStr === undefined ? {} : { diffStr }),
      };
    }
  } else if (last.tone === "tool" || type !== undefined) {
    const toolName = text(payload.toolName, nativeItem.name, rawInput.name, payload.title) ?? null;
    const toolInput = nativeItem.input ?? data.rawInput ?? data.input ?? data;
    const output = nativeItem.output ?? nativeItem.result ?? data.rawOutput ?? data.output;
    return {
      ...base,
      type: "dynamic_tool",
      toolName,
      input: toolInput,
      ...(output === undefined ? {} : { output }),
    };
  } else if (last.kind === "context-compaction") {
    const metadata = record(record(payload.detail).compact_metadata);
    const beforeTokenCount = count(metadata.pre_tokens);
    const afterTokenCount = count(metadata.post_tokens);
    return {
      ...base,
      status: "completed",
      type: "compaction",
      driver: null,
      ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
      ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
    };
  } else if (
    last.kind.startsWith("task.") ||
    (last.tone !== "error" && last.kind !== "runtime.warning")
  ) {
    const summary = text(payload.summary, payload.title) ?? last.summary;
    const detail = text(payload.detail);
    return {
      ...base,
      status: "completed",
      type: "notification",
      source: notificationSource(last),
      outcome: notificationOutcome(last),
      summary,
      ...(detail === undefined || detail === summary ? {} : { detail }),
    };
  } else {
    return { ...base, type: "system_notice", message: last.summary };
  }
}

/** Canonical, inert V2 records with lossless source metadata for older histories. */
export function legacyHistoricalItems(input: {
  readonly legacy: Pick<OrchestrationThread, "activities" | "checkpoints">;
  readonly thread: OrchestrationV2AppThread;
  readonly cwd: string;
  readonly prefix: string;
}): OrchestrationV2DomainEvent[] {
  const { thread, legacy, prefix } = input;
  const events: OrchestrationV2DomainEvent[] = [];
  const rootId = NodeId.make(`import:v1:history-root:${thread.id}`);
  const pushItem = (item: OrchestrationV2TurnItem) =>
    events.push({
      type: "turn-item.updated",
      id: EventId.make(`${prefix}:item:${item.id}`),
      threadId: thread.id,
      occurredAt: item.updatedAt,
      payload: item,
    });
  const groups = new Map<string, OrchestrationThread["activities"][number][]>();
  for (const activity of legacy.activities) {
    const payload = record(activity.payload);
    const callId = text(payload.toolCallId);
    const key = callId === undefined ? activity.id : `${activity.turnId}:${callId}`;
    const group = groups.get(key) ?? [];
    group.push(activity);
    groups.set(key, group);
  }
  let ordinal = 0;
  for (const [key, activities] of groups) {
    const id = TurnItemId.make(`import:v1:activity:${thread.id}:${key}`);
    const ordered = activities.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = ordered[0];
    const last = ordered.at(-1);
    const terminal = ordered.findLast((activity) => activity.kind === "tool.completed") ?? last;
    const payload = record(terminal?.payload);
    const data = record(payload.data);
    const nativeItem = record(data.item);
    const rawInput = record(data.rawInput);
    const type = text(payload.itemType, nativeItem.type);
    if (
      first === undefined ||
      last === undefined ||
      terminal === undefined ||
      (type !== "collab_agent_tool_call" && type !== "subagent" && type !== "agent_spawn")
    ) {
      const item = legacyActivityTurnItem(
        { id, threadId: thread.id, ordinal: ordinal + 1 },
        activities,
      );
      if (item === null) continue;
      ordinal += 1;
      pushItem(item);
      continue;
    }
    const status = historicalStatus(payload.status, terminal.kind);
    const base = {
      id,
      threadId: thread.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ++ordinal,
      status,
      title: text(payload.title) ?? last.summary,
      startedAt: DateTime.makeUnsafe(first.createdAt),
      completedAt: DateTime.makeUnsafe(last.createdAt),
      updatedAt: DateTime.makeUnsafe(last.createdAt),
      legacyActivities: activities.map(activityReference),
      ...(last.turnId === null ? {} : { legacyTurnId: last.turnId }),
    };
    const subagentId = NodeId.make(`import:v1:subagent:${thread.id}:${key}`);
    const prompt = text(nativeItem.prompt, rawInput.prompt, payload.prompt, payload.detail) ?? "";
    const result = text(nativeItem.result, data.result, payload.result) ?? null;
    const driver = ProviderDriverKind.make(
      thread.providerInstanceId === "claude" ? "claudeAgent" : "codex",
    );
    const nodeStatus =
      status === "completed" || status === "failed" || status === "cancelled"
        ? status
        : "interrupted";
    events.push({
      type: "node.updated",
      id: EventId.make(`${prefix}:node:${subagentId}`),
      threadId: thread.id,
      occurredAt: base.updatedAt,
      payload: {
        id: subagentId,
        threadId: thread.id,
        runId: null,
        parentNodeId: rootId,
        rootNodeId: rootId,
        kind: "subagent",
        status: nodeStatus,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: base.startedAt,
        completedAt: base.completedAt,
      },
    });
    events.push({
      type: "subagent.updated",
      id: EventId.make(`${prefix}:subagent:${subagentId}`),
      threadId: thread.id,
      occurredAt: base.updatedAt,
      payload: {
        id: subagentId,
        threadId: thread.id,
        runId: null,
        parentNodeId: rootId,
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId: thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt,
        title: base.title,
        model: null,
        status: nodeStatus,
        result,
        startedAt: base.startedAt,
        completedAt: base.completedAt,
        updatedAt: base.updatedAt,
      },
    });
    pushItem({
      ...base,
      type: "subagent",
      nodeId: subagentId,
      subagentId,
      origin: "provider_native",
      driver,
      providerInstanceId: thread.providerInstanceId,
      childThreadId: null,
      prompt,
      result,
    });
  }
  if (groups.size > 0 || legacy.checkpoints.length > 0) {
    events.unshift({
      type: "node.updated",
      id: EventId.make(`${prefix}:history-root:${thread.id}`),
      threadId: thread.id,
      occurredAt: thread.updatedAt,
      payload: {
        id: rootId,
        threadId: thread.id,
        runId: null,
        parentNodeId: null,
        rootNodeId: rootId,
        kind: "system",
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: thread.createdAt,
        completedAt: thread.updatedAt,
      },
    });
  }
  if (legacy.checkpoints.length > 0) {
    const scopeId = CheckpointScopeId.make(`import:v1:checkpoint-scope:${thread.id}`);
    events.push({
      type: "checkpoint-scope.created",
      id: EventId.make(`${prefix}:scope:${thread.id}`),
      threadId: thread.id,
      occurredAt: thread.createdAt,
      payload: {
        id: scopeId,
        threadId: thread.id,
        runId: null,
        nodeId: rootId,
        parentScopeId: null,
        providerThreadId: null,
        kind: "manual",
        ordinalWithinParent: 0,
        advancesAppRunCount: false,
        cwd: input.cwd,
        createdAt: thread.createdAt,
      },
    });
    let previous: ReturnType<typeof CheckpointId.make> | null = null;
    for (const [index, checkpoint] of legacy.checkpoints.entries()) {
      const id = CheckpointId.make(`import:v1:checkpoint:${thread.id}:${checkpoint.turnId}`);
      const capturedAt = DateTime.makeUnsafe(checkpoint.completedAt);
      events.push({
        type: "checkpoint.captured",
        id: EventId.make(`${prefix}:checkpoint:${id}`),
        threadId: thread.id,
        occurredAt: capturedAt,
        payload: {
          id,
          threadId: thread.id,
          scopeId,
          runId: null,
          nodeId: rootId,
          parentCheckpointId: previous,
          ordinalWithinScope: index + 1,
          appRunOrdinal: null,
          ref: checkpoint.checkpointRef,
          status: checkpoint.status,
          files: checkpoint.files,
          capturedAt,
          legacyTurnId: checkpoint.turnId,
          assistantMessageId: checkpoint.assistantMessageId,
          legacyCheckpointTurnCount: checkpoint.checkpointTurnCount,
        },
      });
      previous = id;
    }
  }
  return events;
}
