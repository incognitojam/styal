import type {
  OrchestrationLatestTurnState,
  OrchestrationSessionStatus,
  TurnId,
} from "@t3tools/contracts";

export interface CompletionSoundThreadSnapshot {
  turnId: TurnId | null;
  state: OrchestrationLatestTurnState | null;
  sessionStatus: OrchestrationSessionStatus | null;
  hasPendingUserInput: boolean;
  pendingInputSoundReady: boolean;
}

export function shouldPlayCompletionSound(
  previous: CompletionSoundThreadSnapshot | undefined,
  current: CompletionSoundThreadSnapshot,
): boolean {
  return Boolean(
    previous &&
    previous.state === "running" &&
    previous.turnId !== null &&
    (runningTurnCompleted(previous, current) || runningTurnClearedAfterCompletion(current)),
  );
}

export function shouldPlayPendingInputSound(
  previous: CompletionSoundThreadSnapshot | undefined,
  current: CompletionSoundThreadSnapshot,
): boolean {
  return (
    previous !== undefined &&
    current.pendingInputSoundReady &&
    !previous.hasPendingUserInput &&
    current.hasPendingUserInput
  );
}

function runningTurnCompleted(
  previous: CompletionSoundThreadSnapshot,
  current: CompletionSoundThreadSnapshot,
): boolean {
  return current.turnId === previous.turnId && current.state === "completed";
}

function runningTurnClearedAfterCompletion(current: CompletionSoundThreadSnapshot): boolean {
  return (
    current.turnId === null &&
    current.state === null &&
    (current.sessionStatus === null ||
      current.sessionStatus === "idle" ||
      current.sessionStatus === "ready")
  );
}

export function reconcileCompletionSoundSnapshots(
  previousByThreadKey: ReadonlyMap<string, CompletionSoundThreadSnapshot>,
  currentByThreadKey: ReadonlyMap<string, CompletionSoundThreadSnapshot>,
): ReadonlyArray<string> {
  const notifiableThreadKeys: string[] = [];

  for (const [threadKey, current] of currentByThreadKey) {
    const previous = previousByThreadKey.get(threadKey);
    if (
      shouldPlayCompletionSound(previous, current) ||
      shouldPlayPendingInputSound(previous, current)
    ) {
      notifiableThreadKeys.push(threadKey);
    }
  }

  return notifiableThreadKeys;
}
