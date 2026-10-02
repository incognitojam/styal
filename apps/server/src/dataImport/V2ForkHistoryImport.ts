import {
  CheckpointId,
  CheckpointScopeId,
  MessageId,
  NodeId,
  PlanId,
  TurnId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import {
  addThreadTokenUsage,
  deriveProjectionTurnUsage,
  sumThreadTokenUsage,
} from "@t3tools/shared/turnUsage";
import { isOrchestrationV2SupersededInterrupt } from "@t3tools/shared/orchestrationV2Timeline";
import { isTurnItemAtOrBeforeRun } from "../orchestration-v2/ProjectionStore.ts";

/** An excluded ancestor contributes history, without becoming a visible imported thread. */
export function materializeV2ForkHistory(
  source: OrchestrationV2ThreadProjection,
  availableThreads: ReadonlySet<string>,
  readAncestor: (id: ThreadId) => OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const fork = source.thread.forkedFrom;
  if (fork?.type !== "run" || availableThreads.has(fork.threadId)) return source;
  const inherited: Array<{
    projection: OrchestrationV2ThreadProjection;
    items: OrchestrationV2TurnItem[];
  }> = [];
  const visited = new Set<string>([source.thread.id]);
  const collect = (id: ThreadId, runId: string) => {
    if (visited.has(id)) throw new Error("The imported fork ancestry contains a cycle.");
    visited.add(id);
    const parent = readAncestor(id);
    const anchor = parent.runs.find((run) => run.id === runId);
    if (anchor === undefined) throw new Error("The imported fork's source run is missing.");
    if (!parent.thread.forkHistoryMaterialized && parent.thread.forkedFrom?.type === "run")
      collect(parent.thread.forkedFrom.threadId, parent.thread.forkedFrom.runId);
    const ordinals = new Map(parent.runs.map((run) => [run.id, run.ordinal]));
    inherited.push({
      projection: parent,
      items: parent.turnItems.filter(
        (item) =>
          isTurnItemAtOrBeforeRun({
            historyOrigin: parent.thread.historyOrigin,
            forkHistoryMaterialized: parent.thread.forkHistoryMaterialized,
            itemRunId: item.runId,
            runOrdinalById: ordinals,
            sourceRunOrdinal: anchor.ordinal,
          }) &&
          !isOrchestrationV2SupersededInterrupt({
            item,
            attempts: parent.attempts,
            items: parent.turnItems,
          }),
      ),
    });
  };
  collect(fork.threadId, fork.runId);
  const scope = `import:v2:inherited:${source.thread.id}`;
  const items: OrchestrationV2TurnItem[] = [];
  const messages = [...source.messages];
  const nodes = [...source.nodes];
  const plans = [...source.plans];
  const checkpoints = [...source.checkpoints];
  const checkpointScopes = [...source.checkpointScopes];
  const records = [...(source.legacyTurnUsage?.records ?? [])];
  for (const { projection, items: prefix } of inherited) {
    const key = (id: string) => `${scope}:${projection.thread.id}:${id}`;
    const itemIds = new Map(prefix.map((item) => [item.id, TurnItemId.make(key(item.id))]));
    const messageIds = new Map(
      prefix.flatMap((item) =>
        item.type === "assistant_message" || item.type === "user_message"
          ? [[item.messageId, MessageId.make(key(item.messageId))] as const]
          : [],
      ),
    );
    const includedRuns = new Set<string>(
      prefix.flatMap((item) => (item.runId === null ? [] : [item.runId])),
    );
    const usage = deriveProjectionTurnUsage(projection);
    for (const [id, record] of usage.byTurnId) {
      if (!includedRuns.has(id) && !prefix.some((item) => item.legacyTurnId === id)) continue;
      records.push({ turnId: TurnId.make(key(id)), ...record });
    }
    for (const item of prefix) {
      const turnId = item.legacyTurnId ?? item.runId;
      items.push({
        ...item,
        id: itemIds.get(item.id)!,
        threadId: source.thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: item.type === "fork" ? undefined : null,
        providerTurnId: null,
        parentItemId: item.parentItemId === null ? null : (itemIds.get(item.parentItemId) ?? null),
        ...(turnId === null || turnId === undefined ? {} : { legacyTurnId: key(turnId) }),
        ordinal: items.length,
        ...(item.type === "assistant_message" || item.type === "user_message"
          ? { messageId: messageIds.get(item.messageId)! }
          : {}),
        ...(item.type === "checkpoint"
          ? {
              checkpointId: CheckpointId.make(key(item.checkpointId)),
              scopeId: CheckpointScopeId.make(key(item.scopeId)),
            }
          : {}),
        ...(item.type === "proposed_plan" || item.type === "todo_list"
          ? { planId: PlanId.make(key(item.planId)) }
          : {}),
      } as OrchestrationV2TurnItem);
    }
    for (const message of projection.messages) {
      const id = messageIds.get(message.id);
      if (id === undefined) continue;
      const turnId = message.legacyTurnId ?? message.runId;
      messages.push({
        ...message,
        id,
        threadId: source.thread.id,
        runId: null,
        nodeId: null,
        streaming: false,
        ...(turnId === null || turnId === undefined ? {} : { legacyTurnId: key(turnId) }),
      });
    }
    for (const plan of projection.plans) {
      if (
        !prefix.some(
          (item) =>
            (item.type === "proposed_plan" || item.type === "todo_list") && item.planId === plan.id,
        )
      )
        continue;
      const nodeId = NodeId.make(key(plan.nodeId));
      if (!nodes.some((entry) => entry.id === nodeId))
        nodes.push({
          id: nodeId,
          threadId: source.thread.id,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "system",
          status: "completed",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: source.thread.createdAt,
          completedAt: source.thread.createdAt,
        });
      plans.push({
        ...plan,
        id: PlanId.make(key(plan.id)),
        threadId: source.thread.id,
        runId: null,
        nodeId,
      });
    }
    for (const checkpoint of projection.checkpoints) {
      if (checkpoint.runId !== null && !includedRuns.has(checkpoint.runId)) continue;
      const nodeId = NodeId.make(key(checkpoint.nodeId));
      const scopeId = CheckpointScopeId.make(key(checkpoint.scopeId));
      const originalScope = projection.checkpointScopes.find(
        (entry) => entry.id === checkpoint.scopeId,
      );
      if (originalScope === undefined)
        throw new Error("The imported checkpoint's scope is missing.");
      if (!nodes.some((entry) => entry.id === nodeId))
        nodes.push({
          id: nodeId,
          threadId: source.thread.id,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "system",
          status: "completed",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: checkpoint.capturedAt,
          completedAt: checkpoint.capturedAt,
        });
      if (!checkpointScopes.some((entry) => entry.id === scopeId))
        checkpointScopes.push({
          ...originalScope,
          id: scopeId,
          threadId: source.thread.id,
          runId: null,
          nodeId,
          parentScopeId: null,
          providerThreadId: null,
          kind: "manual",
          advancesAppRunCount: false,
        });
      checkpoints.push({
        ...checkpoint,
        id: CheckpointId.make(key(checkpoint.id)),
        threadId: source.thread.id,
        scopeId,
        runId: null,
        nodeId,
        parentCheckpointId: null,
        appRunOrdinal: null,
        ...(checkpoint.assistantMessageId == null
          ? {}
          : { assistantMessageId: messageIds.get(checkpoint.assistantMessageId) ?? null }),
      });
    }
  }
  const inheritedRecords = records.slice(source.legacyTurnUsage?.records.length ?? 0);
  const inheritedTotal = sumThreadTokenUsage({
    activities: inheritedRecords.map((record) => ({
      turnId: record.turnId,
      payload: record.usage,
    })),
    turnId: "import:no-extra-turn",
    usage: null,
    turns: inheritedRecords.length,
  });
  const frozenTotal =
    source.legacyTurnUsage === undefined
      ? inheritedTotal
      : addThreadTokenUsage(source.legacyTurnUsage.thread, inheritedTotal);
  const marker: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`${scope}:fork`),
    threadId: source.thread.id,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: items.length,
    status: "completed",
    title: "Forked from conversation",
    startedAt: null,
    completedAt: source.thread.createdAt,
    updatedAt: source.thread.createdAt,
    type: "fork",
    source: { type: "run", threadId: fork.threadId, runId: fork.runId },
    targetThreadId: source.thread.id,
  };
  return {
    ...source,
    thread: { ...source.thread, forkHistoryMaterialized: true },
    nodes,
    plans,
    messages,
    checkpoints,
    checkpointScopes,
    turnItems: [...items, marker, ...source.turnItems],
    legacyTurnUsage: { records, thread: frozenTotal },
    providerTurns: source.providerTurns.map((turn) =>
      turn.threadTokenUsage === undefined
        ? turn
        : { ...turn, threadTokenUsage: addThreadTokenUsage(turn.threadTokenUsage, inheritedTotal) },
    ),
  };
}
