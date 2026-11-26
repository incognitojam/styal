import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useFreshSessionArmed } from "./freshSessionArms";
import type { ModelSelection } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  latestProviderTurnTokenUsage,
  deriveLatestContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";
import { useGT } from "gt-react";
import { useQuietThreadProjection } from "../../state/entities";
import { useNowAfter } from "../../hooks/useDeadline";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { Button } from "../ui/button";

type Provider = Pick<ProviderInstanceEntry, "instanceId" | "driverKind" | "continuationGroupKey">;
export function discardsClaudeModelCache(input: {
  current: ModelSelection | null | undefined;
  next: ModelSelection;
  providers: readonly Provider[];
  usedTokens: number | null | undefined;
  updatedAt: string | null | undefined;
  ttl?: number | undefined;
  now: number;
}) {
  const { current, next } = input;
  const from = input.providers.find((p) => p.instanceId === current?.instanceId);
  const to = input.providers.find((p) => p.instanceId === next.instanceId);
  const age = input.now - Date.parse(input.updatedAt ?? "");
  return (
    !!current &&
    from?.driverKind === "claudeAgent" &&
    to?.driverKind === "claudeAgent" &&
    (from.instanceId === to.instanceId ||
      (from.continuationGroupKey !== undefined &&
        from.continuationGroupKey === to.continuationGroupKey)) &&
    (from.instanceId !== to.instanceId || current.model !== next.model) &&
    (input.usedTokens ?? 0) >= COMPACTION_SUGGESTION_MIN_TOKENS &&
    age >= 0 &&
    age < (input.ttl ?? 60 * 60_000)
  );
}

export function useClaudeModelCacheWarning(
  ref: ScopedThreadRef | null,
  next: ModelSelection,
  providers: readonly Provider[],
  undo: (selection: ModelSelection) => void,
): ComposerBannerStackItem | null {
  const gt = useGT();
  const freshSession = useFreshSessionArmed(ref ? scopedThreadKey(ref) : "");
  const scoped = useQuietThreadProjection(ref);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const projection = scoped?.projection;
  const thread = projection?.providerThreads.find(
    (t) => t.id === projection.thread.activeProviderThreadId,
  );
  const usage = latestProviderTurnTokenUsage(projection?.providerTurns ?? [], projection, thread);
  const context = deriveLatestContextWindowSnapshot(
    projection?.visibleTurnItems ?? [],
    usage,
    thread,
  );
  const expiresAt = Date.parse(context?.updatedAt ?? "") + (usage?.promptCacheTtlMs ?? 60 * 60_000);
  const now = useNowAfter(Number.isFinite(expiresAt) ? expiresAt : null);
  const current = projection?.runs.findLast((run) => run.startedAt !== null)?.modelSelection;
  const key = JSON.stringify([ref, current, next, context?.updatedAt]);
  if (
    freshSession ||
    dismissed.has(key) ||
    !discardsClaudeModelCache({
      current,
      next,
      providers,
      usedTokens: context?.usedTokens,
      updatedAt: context?.updatedAt,
      ttl: usage?.promptCacheTtlMs,
      now,
    })
  )
    return null;
  const title = gt("Switching model skips the cache");
  const description = gt("Resends {tokens} tokens", {
    tokens: formatContextWindowTokens(context!.usedTokens!),
  });
  return {
    id: `cache-loss:${key}`,
    variant: "info",
    icon: <HistoryIcon />,
    title,
    description,
    actions: (
      <Button size="xs" variant="ghost" onClick={() => undo(current!)}>
        {gt("Undo")}
      </Button>
    ),
    dismissLabel: gt("Keep change"),
    onDismiss: () => setDismissed((keys) => new Set(keys).add(key)),
  };
}
