import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { useThreadShells } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";

export function ThreadVisitBaselineObserver() {
  const threadShells = useThreadShells();
  const pendingThreadVisitBaselineKeys = useUiStateStore(
    (state) => state.pendingThreadVisitBaselineKeys,
  );
  const resolveThreadVisitBaseline = useUiStateStore((state) => state.resolveThreadVisitBaseline);

  useEffect(() => {
    if (pendingThreadVisitBaselineKeys.length === 0) return;
    const pendingKeys = new Set(pendingThreadVisitBaselineKeys);
    for (const thread of threadShells) {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const requestedAt = thread.latestTurn?.requestedAt;
      if (pendingKeys.has(threadKey) && requestedAt) {
        resolveThreadVisitBaseline(threadKey, requestedAt);
      }
    }
  }, [pendingThreadVisitBaselineKeys, resolveThreadVisitBaseline, threadShells]);

  return null;
}
