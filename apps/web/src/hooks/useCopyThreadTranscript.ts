import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { buildThreadTranscript } from "../lib/threadTranscript";
import { threadSnapshotCommands } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  clipboardWriteEpoch,
  ensureClipboardEpochTracking,
  useCopyToClipboard,
} from "./useCopyToClipboard";

// Shared across hook instances so only the latest copy request touches the clipboard. The
// clipboard epoch cannot order two pending transcript fetches, since neither has written yet.
let latestRequestId = 0;

function nextRequestId() {
  latestRequestId += 1;
  return latestRequestId;
}

function transcriptFailureToast(description: string) {
  toastManager.add(
    stackedThreadToast({ type: "error", title: "Failed to copy transcript", description }),
  );
}

/**
 * Copies a thread's conversation to the clipboard as markdown. Fetches a full
 * snapshot on demand instead of reading cached detail state, which only holds
 * a turn window (or nothing at all for a thread that was never opened).
 */
export function useCopyThreadTranscript() {
  const fetchSnapshot = useAtomCommand(threadSnapshotCommands.fetchFull, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<{ messageCount: number }>({
    target: "transcript",
    onCopy: ({ messageCount }) => {
      toastManager.add({
        type: "success",
        title: "Transcript copied",
        description: `${messageCount} message${messageCount === 1 ? "" : "s"}`,
      });
    },
    onError: (error) => {
      transcriptFailureToast(error.message);
    },
  });

  return async (threadRef: ScopedThreadRef) => {
    ensureClipboardEpochTracking();
    const requestId = nextRequestId();
    const epochAtRequest = clipboardWriteEpoch();
    const result = await fetchSnapshot({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    // Superseded while fetching — by a newer transcript copy or by anything
    // else the user copied — so that write owns the clipboard now. Drop this
    // result without writing or toasting.
    if (requestId !== latestRequestId || clipboardWriteEpoch() !== epochAtRequest) {
      return;
    }
    if (result._tag === "Failure" && isAtomCommandInterrupted(result)) {
      return;
    }
    const snapshot = result._tag === "Failure" ? null : Option.getOrNull(result.value);
    if (snapshot === null) {
      const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
      transcriptFailureToast(
        error instanceof Error ? error.message : "Could not load the conversation from the server.",
      );
      return;
    }
    const thread = snapshot.thread;
    if (thread === null) {
      transcriptFailureToast("Could not load the conversation from the server.");
      return;
    }
    const transcript = buildThreadTranscript(thread.title, snapshot.visibleTurnItems);
    if (transcript.messageCount === 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Nothing to copy",
          description: "This thread has no messages yet.",
        }),
      );
      return;
    }
    copyToClipboard(transcript.text, { messageCount: transcript.messageCount });
  };
}
