import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { buildThreadTranscript } from "../lib/threadTranscript";
import { threadSnapshotCommands } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useCopyToClipboard } from "./useCopyToClipboard";

// Shared across hook instances (sidebar and chat header dispatch through
// separate instances): only the most recent copy request may touch the
// clipboard. Without this, a slow fetch for one thread lands after a quicker
// copy of another and silently overwrites it with the wrong transcript.
let latestRequestId = 0;

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
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy transcript",
          description: error.message,
        }),
      );
    },
  });

  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const requestId = ++latestRequestId;
      const result = await fetchSnapshot({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      // Superseded by a newer copy while fetching: the newer request owns the
      // clipboard, so drop this result without writing or toasting.
      if (requestId !== latestRequestId) {
        return;
      }
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to copy transcript",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      const snapshot = Option.getOrNull(result.value);
      if (snapshot === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy transcript",
            description: "Could not load the conversation from the server.",
          }),
        );
        return;
      }
      const transcript = buildThreadTranscript(snapshot.thread.title, snapshot.thread.messages);
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
    },
    [copyToClipboard, fetchSnapshot],
  );
}
