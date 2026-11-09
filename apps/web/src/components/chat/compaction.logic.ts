import type {
  ModelCapabilities,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";

// Fallback TTL: Claude Code's one-hour subscription cache. Claude Code's own prompt waits 70
// minutes; the banner offers compaction as soon as the cache has expired.
const CLAUDE_PROMPT_CACHE_FALLBACK_MS = 60 * 60_000;
// Warn only for models known to send effort per request. New models may send
// perTurnEffort in conversation history, where changing effort preserves the cache.
// Fable 5 and Sonnet 5.5 are unmeasured; omit them to avoid unsupported warnings.
const CLAUDE_PER_REQUEST_EFFORT_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

export function resolveCacheLossBaseline(input: {
  readonly runs: ReadonlyArray<{
    readonly startedAt: unknown;
    readonly modelSelection: ModelSelection;
  }>;
  readonly inheritedSelection: ModelSelection | null | undefined;
}): ModelSelection | null | undefined {
  return (
    input.runs.findLast((run) => run.startedAt !== null)?.modelSelection ?? input.inheritedSelection
  );
}

function providerSupportsManualCompaction(
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

export { shouldOfferResumeCompaction } from "@t3tools/client-runtime/state/context-window";

export type ClaudeCacheLossChange = "model" | "effort" | "fastMode";

/**
 * `null` when the cache survives the change or has already expired. `capabilities` belong to the
 * pending model and resolve unset options to their defaults, so an explicit default is not a change.
 */
export function claudeSelectionCacheLoss(input: {
  readonly provider: string | null | undefined;
  readonly current: ModelSelection | null | undefined;
  readonly next: ModelSelection;
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  readonly now: string;
}): ClaudeCacheLossChange | null {
  const { current, next } = input;
  if (
    input.provider !== "claudeAgent" ||
    !current ||
    (input.usedTokens ?? 0) < COMPACTION_SUGGESTION_MIN_TOKENS
  ) {
    return null;
  }
  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  if (
    !Number.isFinite(updatedAt) ||
    !Number.isFinite(now) ||
    now - updatedAt >= (input.promptCacheTtlMs ?? CLAUDE_PROMPT_CACHE_FALLBACK_MS)
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
    CLAUDE_PER_REQUEST_EFFORT_MODELS.has(next.model) &&
    optionValue(current, "effort") !== optionValue(next, "effort")
  ) {
    return "effort";
  }
  return null;
}

export function formatContextWindowCompactionMessage(autoCompactThreshold?: number | null): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return "Context compacts automatically when needed.";
}
