import type {
  ModelCapabilities,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

// Claude Code writes its prompt cache with a one-hour TTL, so a resume after an
// hour resends the whole history uncached. Claude Code's own prompt waits 70
// minutes; the banner offers compaction as soon as the cache has expired.
const CLAUDE_PROMPT_CACHE_MINUTES = 60;
// Below this, resending the history uncached costs too little to interrupt.
const CLAUDE_LARGE_CONTEXT_TOKENS = 100_000;
// Claude Code sends effort inside the conversation for these models, so an
// effort change keeps the cached history. On other models it sends effort as
// a request parameter and an effort change resends the history uncached.
// Claude Code enables this per model: add a model once its transcripts record
// `perTurnEffort` on assistant entries.
const CLAUDE_PER_TURN_EFFORT_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
]);

export function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") return false;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") return false;
    const answers = (payload as { readonly answers?: unknown }).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly now: string;
}): boolean {
  if (input.provider !== "claudeAgent" || (input.usedTokens ?? 0) < CLAUDE_LARGE_CONTEXT_TOKENS) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= CLAUDE_PROMPT_CACHE_MINUTES * 60_000
  );
}

export type ClaudeCacheLossChange = "model" | "effort" | "fastMode";

/**
 * Which pending composer change would make the next Claude turn resend the
 * thread's history uncached, or `null` when the cache survives it or has
 * already expired. `current` is the selection the last turn was sent with;
 * `capabilities` belong to the pending model and resolve unset options to
 * their defaults, so writing a default out explicitly is not a change.
 */
export function claudeSelectionCacheLoss(input: {
  readonly provider: string | null | undefined;
  readonly current: ModelSelection | null | undefined;
  readonly next: ModelSelection;
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly now: string;
}): ClaudeCacheLossChange | null {
  const { current, next } = input;
  if (
    input.provider !== "claudeAgent" ||
    !current ||
    (input.usedTokens ?? 0) < CLAUDE_LARGE_CONTEXT_TOKENS
  ) {
    return null;
  }
  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  if (
    !Number.isFinite(updatedAt) ||
    !Number.isFinite(now) ||
    now - updatedAt >= CLAUDE_PROMPT_CACHE_MINUTES * 60_000
  ) {
    return null;
  }

  // Prompt caches belong to one model and one account.
  if (current.instanceId !== next.instanceId || current.model !== next.model) {
    return "model";
  }
  const caps = input.capabilities;
  if (!caps) {
    return null;
  }
  const optionValue = (selection: ModelSelection, id: string) =>
    getProviderOptionCurrentValue(
      getProviderOptionDescriptors({ caps, selections: selection.options }).find(
        (descriptor) => descriptor.id === id,
      ),
    );
  // Fast mode changes the request's speed, which the API caches separately.
  if ((optionValue(current, "fastMode") ?? false) !== (optionValue(next, "fastMode") ?? false)) {
    return "fastMode";
  }
  if (
    !CLAUDE_PER_TURN_EFFORT_MODELS.has(next.model) &&
    optionValue(current, "effort") !== optionValue(next, "effort")
  ) {
    return "effort";
  }
  return null;
}

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getTriggerDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

/**
 * Whether the footer should hold the meter's slot before a snapshot exists.
 *
 * The snapshot comes from thread activities, which load after the shell.
 * Reserving the slot while the detail loads, for a started thread, keeps the
 * attach button still until the meter mounts. Once the detail is in, a
 * missing snapshot means there is no usage to show and nothing is reserved.
 *
 * The meter renders from stored activities whatever the provider's state, so
 * only a provider known not to stream usage skips the reservation. An unknown
 * provider (catalog still loading, or the thread's provider disabled) reserves.
 */
export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  /** `null` while the thread's provider is not in the catalog. */
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
}
