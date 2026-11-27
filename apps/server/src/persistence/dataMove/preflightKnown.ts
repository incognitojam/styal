import * as C from "@t3tools/contracts";
import * as S from "effect/Schema";

// Historical shapes from source 68e0ea592ac; these diagnose differences, never adapt stored data.
export const serverCapability = S.Struct({
  type: S.Literal("server"),
  attention: S.optional(S.Literal("input")),
});
export const backgroundCommand = S.Struct({
  nativeItemId: C.TrimmedNonEmptyString,
  turnItemId: C.TurnItemId,
  nodeId: C.NodeId,
  threadId: C.ThreadId,
  runId: S.NullOr(C.RunId),
  rootNodeId: C.NodeId,
  parentNodeId: C.NodeId,
  providerThreadId: S.NullOr(C.ProviderThreadId),
  providerTurnId: S.NullOr(C.ProviderTurnId),
  ordinal: C.NonNegativeInt,
  input: S.String,
  startedAt: C.TrimmedNonEmptyString,
});
const usd = S.Number.check(S.isFinite(), S.isGreaterThanOrEqualTo(0));
const historicalTurnUsage = C.TurnTokenUsage.mapMembers((members) =>
  members.map((member) =>
    member.mapFields((fields) => ({
      ...fields,
      subagents: S.optional(
        S.Struct({
          inputTokens: C.NonNegativeInt,
          cachedInputTokens: S.optional(C.NonNegativeInt),
          cacheCreationTokens: S.optional(C.NonNegativeInt),
          outputTokens: C.NonNegativeInt,
          reasoningTokens: S.optional(C.NonNegativeInt),
        }),
      ),
      byModel: S.optional(
        S.Array(
          S.Struct({
            model: S.optional(C.TrimmedNonEmptyString),
            inputTokens: C.NonNegativeInt,
            cachedInputTokens: S.optional(C.NonNegativeInt),
            cacheCreationTokens: S.optional(C.NonNegativeInt),
            outputTokens: C.NonNegativeInt,
            reportedCostUsd: S.optional(usd),
          }),
        ),
      ),
      costUsd: S.optional(usd),
    })),
  ),
);
export const historicalPayloads = {
  "legacy-usage.imported": S.Struct({
    records: S.Array(
      S.Struct({
        turnId: C.TurnId,
        usage: S.NullOr(historicalTurnUsage),
        model: S.NullOr(
          S.Struct({
            instanceId: S.optional(C.ProviderInstanceId),
            model: C.TrimmedNonEmptyString,
            effort: S.optional(C.TrimmedNonEmptyString),
          }),
        ),
      }),
    ),
    thread: S.Struct({
      inputTokens: C.NonNegativeInt,
      cachedInputTokens: C.NonNegativeInt,
      cacheCreationTokens: C.NonNegativeInt,
      outputTokens: C.NonNegativeInt,
      reasoningTokens: C.NonNegativeInt,
      countedTurns: C.NonNegativeInt,
      turns: C.NonNegativeInt,
      partialTurns: C.NonNegativeInt,
      subagentTurns: C.NonNegativeInt,
      subagentTokens: S.optional(C.NonNegativeInt),
      costUsd: S.optional(usd),
      pricedTurns: S.optional(C.NonNegativeInt),
    }),
  }),
  "message.mentioned-times-checked": S.Struct({
    messageId: C.MessageId,
    mentionedTimes: S.Struct({
      checkedAt: C.IsoDateTime,
      spans: S.Array(
        S.Struct({
          start: C.NonNegativeInt,
          end: C.NonNegativeInt,
          text: S.String,
          kind: S.Literals(["moment", "length", "other"]),
          time: S.optional(S.String),
          zone: S.optional(S.String),
          date: S.optional(S.String),
        }),
      ),
    }),
  }),
};
export const removedFields: Record<string, readonly string[]> = {
  threads: [
    "branchTurnContext",
    "reportDismissals",
    "answerNotes",
    "workflowRuns",
    "reportTo",
    "settleReason",
    "authRecovery",
    "pullRequests.[].turnContext",
    "pullRequests.[].snapshot.autoMergeEnabled",
    "pullRequests.[].snapshot.inMergeQueue",
  ],
  runs: ["cancelledByThreadId", "restartHeldRunIds"],
  provider_threads: ["mcpServerName", "inlineContextIds", "pendingBackgroundTasks.[].toolUseId"],
  provider_turns: [
    "nativePromptRef",
    "turnModel",
    "threadTokenUsage",
    "inlineContextIds",
    "turnTokenUsage.subagents",
    "turnTokenUsage.byModel",
    "turnTokenUsage.costUsd",
  ],
  "projection_thread_pull_requests.snapshot_json": ["autoMergeEnabled", "inMergeQueue"],
  messages: [
    "report",
    "reportAnswer",
    "usageLimitContinuationOfRunId",
    "legacyTurnId",
    "mentionedTimes",
    "notification.source.childThreadId",
  ],
  checkpoints: ["legacyTurnId", "assistantMessageId", "legacyCheckpointTurnCount"],
  turn_items: [
    "report",
    "legacyTurnId",
    "legacyActivities",
    "toolDenial",
    "setupScript",
    "fetchedUrl",
    "toolInput",
    "providerStall",
    "viewedDocument",
    "toolName",
  ],
  subagents: ["supersedesUpdates", "followsAfterRunId", "followUpOf", "wakeWhen"],
};
