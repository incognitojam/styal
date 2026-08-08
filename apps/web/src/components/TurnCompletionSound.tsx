import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect, useMemo, useRef } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useThreadShells } from "../state/entities";
import { playCompletionSound } from "../lib/completionSound";
import {
  reconcileCompletionSoundSnapshots,
  type CompletionSoundThreadSnapshot,
} from "../lib/completionSound.logic";

export function TurnCompletionSound() {
  const threadShells = useThreadShells();
  const completionSound = useClientSettings((settings) => settings.completionSound);
  const snapshotsByThreadKey = useMemo(() => {
    const next = new Map<string, CompletionSoundThreadSnapshot>();
    for (const thread of threadShells) {
      next.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), {
        turnId: thread.latestTurn?.turnId ?? null,
        state: thread.latestTurn?.state ?? null,
        sessionStatus: thread.session?.status ?? null,
      });
    }
    return next;
  }, [threadShells]);
  const previousSnapshotsByThreadKeyRef = useRef<ReadonlyMap<
    string,
    CompletionSoundThreadSnapshot
  > | null>(null);

  useEffect(() => {
    const previousSnapshotsByThreadKey = previousSnapshotsByThreadKeyRef.current;
    if (previousSnapshotsByThreadKey !== null) {
      const completedThreadKeys = reconcileCompletionSoundSnapshots(
        previousSnapshotsByThreadKey,
        snapshotsByThreadKey,
      );
      if (completedThreadKeys.length > 0) {
        playCompletionSound(completionSound);
      }
    }
    previousSnapshotsByThreadKeyRef.current = snapshotsByThreadKey;
  }, [completionSound, snapshotsByThreadKey]);

  return null;
}
