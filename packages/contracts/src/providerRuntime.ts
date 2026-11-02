import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

const RuntimeTurnState = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: NonNegativeInt,
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
  autoCompactThreshold: Schema.optional(PositiveInt),
  cost: Schema.optional(
    Schema.Struct({
      amount: Schema.Number.check(Schema.isFinite()),
      currency: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(32)),
    }),
  ),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

/**
 * Tokens a turn's subagents used, kept apart from the main agent's counts.
 * Input includes cache reads and writes; output includes reasoning.
 */
export const SubagentTokenUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  cachedInputTokens: Schema.optional(NonNegativeInt),
  cacheCreationTokens: Schema.optional(NonNegativeInt),
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
});
export type SubagentTokenUsage = typeof SubagentTokenUsage.Type;

const UsdAmount = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

/**
 * Tokens one model used during a turn, main agent and subagents together, for
 * pricing the turn. `model` is absent for the turn's own model. Input includes
 * cache reads and writes. `reportedCostUsd` is the provider's own price.
 */
export const ModelTokenUsage = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  inputTokens: NonNegativeInt,
  cachedInputTokens: Schema.optional(NonNegativeInt),
  cacheCreationTokens: Schema.optional(NonNegativeInt),
  outputTokens: NonNegativeInt,
  reportedCostUsd: Schema.optional(UsdAmount),
});
export type ModelTokenUsage = typeof ModelTokenUsage.Type;

/**
 * Input includes cache reads and writes; output includes reasoning, of which reasoningTokens is
 * a subset. Partial means every included count is valid but the full turn total is unknown.
 */
const TurnTokenUsageCommonFields = {
  usageScope: Schema.Literal("main_agent"),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  cacheCreationTokens: Schema.optional(NonNegativeInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  hasSubagents: Schema.Boolean,
  /** Present when the provider reported what the turn's subagents used. */
  subagents: Schema.optional(SubagentTokenUsage),
  /**
   * The whole turn's tokens by model, for pricing. Without it, every token is
   * priced at the turn's model. The usage record leaves it out.
   */
  byModel: Schema.optional(Schema.Array(ModelTokenUsage)),
  /**
   * Estimated API cost in USD of the main agent and its subagents. The server
   * prices the turn when recording it; subscriptions bill separately.
   */
  costUsd: Schema.optional(UsdAmount),
  // Native model ids the provider reported for the main agent's work. Absent means unknown.
  models: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  // The provider ran a local command; its counters describe that result, not model work.
  localCommand: Schema.optional(Schema.Boolean),
  // Provider-ledger counts beyond the main agent, such as native subagents and compaction.
  otherUsage: Schema.optional(
    Schema.Struct({ inputTokens: NonNegativeInt, outputTokens: NonNegativeInt }),
  ),
};
export const TurnTokenUsage = Schema.Union([
  Schema.Struct({
    ...TurnTokenUsageCommonFields,
    usageStatus: Schema.Literal("complete"),
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
  }),
  Schema.Struct({
    ...TurnTokenUsageCommonFields,
    usageStatus: Schema.Literals(["partial", "unavailable"]),
    inputTokens: Schema.optional(NonNegativeInt),
    outputTokens: Schema.optional(NonNegativeInt),
  }),
]);
export type TurnTokenUsage = typeof TurnTokenUsage.Type;

/**
 * Thread activity holding a finished turn's `TurnTokenUsage` and `TurnModel`,
 * shown under the turn. Recorded when the provider reported some usage or the
 * turn's model is known; without usage it holds only the `TurnModel` fields.
 * Newer records also carry the thread's total as `thread`, a `ThreadTokenUsage`.
 */
export const TURN_USAGE_ACTIVITY_KIND = "turn.usage";

/**
 * The model and effort a turn ran with, as the provider's ids. `effort` is the
 * id of the model's reasoning option, so clients label it as the composer does.
 */
export const TurnModel = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  model: TrimmedNonEmptyStringSchema,
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnModel = typeof TurnModel.Type;

/**
 * A thread's main-agent usage, summed over every turn with a usage record when
 * the newest one was written. Clients see only recent activities, so the
 * server sums instead of leaving clients to add up turns they may not have.
 */
export const ThreadTokenUsage = Schema.Struct({
  /** Main agent and reported subagent usage combined. */
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  /** Turns whose usage is included. */
  countedTurns: NonNegativeInt,
  /** Every turn the thread had, including those without usage. */
  turns: NonNegativeInt,
  partialTurns: NonNegativeInt,
  /** Turns that ran subagents without reporting their usage. */
  subagentTurns: NonNegativeInt,
  /** Reported subagent input and output, already within the totals above. */
  subagentTokens: Schema.optional(NonNegativeInt),
  /** Estimated API cost of the turns that have one. */
  costUsd: Schema.optional(UsdAmount),
  /** Counted turns with a cost. */
  pricedTurns: Schema.optional(NonNegativeInt),
});
export type ThreadTokenUsage = typeof ThreadTokenUsage.Type;

export const ToolActivitySurface = Schema.Literals(["browser", "computer"]);
export type ToolActivitySurface = typeof ToolActivitySurface.Type;

export const ToolActivityNativeAppReference = Schema.Union([
  Schema.TaggedStruct("app-id", {
    appId: TrimmedNonEmptyStringSchema.check(
      Schema.isMaxLength(512),
      Schema.isPattern(/^[A-Za-z0-9._-]+$/u),
    ),
  }),
  Schema.TaggedStruct("display-name", {
    displayName: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  }),
]);
export type ToolActivityNativeAppReference = typeof ToolActivityNativeAppReference.Type;

export const ToolActivityIcon = Schema.Union([
  Schema.TaggedStruct("website", {
    pageUrl: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096)),
    faviconUrl: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
    faviconUrlDark: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
  }),
  Schema.TaggedStruct("native-app", {
    app: ToolActivityNativeAppReference,
  }),
  Schema.TaggedStruct("themed-logo", {
    logoUrl: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096)),
    logoUrlDark: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
  }),
]);
export type ToolActivityIcon = typeof ToolActivityIcon.Type;

export const ToolActivitySource = Schema.Struct({
  key: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(512)),
  name: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160)),
  kind: Schema.Literals(["browser", "computer", "integration"]),
  icon: Schema.optional(ToolActivityIcon),
});
export type ToolActivitySource = typeof ToolActivitySource.Type;

export const CommandInteractionKind = Schema.Literals(["ctrl_c", "ctrl_d", "control", "input"]);
export type CommandInteractionKind = typeof CommandInteractionKind.Type;

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: Schema.String,
  value: Schema.optional(Schema.String),
});

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;
