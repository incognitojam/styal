import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useEnvironmentShellStatuses, useThreadShells } from "../state/entities";
import { playCompletionSound } from "../lib/completionSound";
import {
  reconcileCompletionSoundSnapshots,
  type CompletionSoundThreadSnapshot,
} from "../lib/completionSound.logic";

export function TurnCompletionSound() {
  const threadShells = useThreadShells();
  const environmentShellStatuses = useEnvironmentShellStatuses();
  const completionSound = useClientSettings((settings) => settings.completionSound);
  const pendingInputSoundReadyEnvironmentIdsRef = useRef(new Set<EnvironmentId>());
  const snapshotsByThreadKey = useMemo(() => {
    const next = new Map<string, CompletionSoundThreadSnapshot>();
    for (const thread of threadShells) {
      next.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), {
        turnId: thread.latestTurn?.turnId ?? null,
        state: thread.latestTurn?.state ?? null,
        sessionStatus: thread.session?.status ?? null,
        hasPendingUserInput: thread.hasPendingUserInput,
        pendingInputSoundReady: pendingInputSoundReadyEnvironmentIdsRef.current.has(
          thread.environmentId,
        ),
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
      const notifiableThreadKeys = reconcileCompletionSoundSnapshots(
        previousSnapshotsByThreadKey,
        snapshotsByThreadKey,
      );
      if (notifiableThreadKeys.length > 0) {
        playCompletionSound(completionSound);
      }
    }
    previousSnapshotsByThreadKeyRef.current = snapshotsByThreadKey;

    const knownEnvironmentIds = new Set(environmentShellStatuses.keys());
    for (const environmentId of pendingInputSoundReadyEnvironmentIdsRef.current) {
      if (!knownEnvironmentIds.has(environmentId)) {
        pendingInputSoundReadyEnvironmentIdsRef.current.delete(environmentId);
      }
    }
    for (const [environmentId, status] of environmentShellStatuses) {
      if (status === "live") {
        pendingInputSoundReadyEnvironmentIdsRef.current.add(environmentId);
      }
    }
  }, [completionSound, environmentShellStatuses, snapshotsByThreadKey]);

  return null;
}
