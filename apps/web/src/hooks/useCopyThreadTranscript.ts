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
import {
  clipboardWriteEpoch,
  ensureClipboardEpochTracking,
  useCopyToClipboard,
} from "./useCopyToClipboard";

// Shared across hook instances (sidebar and chat header dispatch through
// separate instances): only the most recent copy request may touch the
// clipboard. The clipboard epoch cannot order two pending transcript fetches
// (neither has written yet), so this id covers transcript-vs-transcript while
// the epoch covers transcript-vs-everything-else.
let latestRequestId = 0;

// Fetches usually settle well under this locally; the loading toast only
// appears when a large thread or a remote connection makes the wait visible.
const PENDING_TOAST_DELAY_MS = 400;

/**
 * Copies a thread's conversation to the clipboard as markdown. Fetches a full
 * snapshot on demand instead of reading cached detail state, which only holds
 * a turn window (or nothing at all for a thread that was never opened).
 */
export function useCopyThreadTranscript() {
  const fetchSnapshot = useAtomCommand(threadSnapshotCommands.fetchFull, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<{
    messageCount: number;
    closePendingToast: () => void;
  }>({
    target: "transcript",
    onCopy: ({ messageCount, closePendingToast }) => {
      closePendingToast();
      toastManager.add({
        type: "success",
        title: "Transcript copied",
        description: `${messageCount} message${messageCount === 1 ? "" : "s"}`,
      });
    },
    onError: (error, { closePendingToast }) => {
      closePendingToast();
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
      ensureClipboardEpochTracking();
      const requestId = ++latestRequestId;
      const epochAtRequest = clipboardWriteEpoch();
      let pendingToastId: ReturnType<typeof toastManager.add> | null = null;
      const pendingToastTimer = window.setTimeout(() => {
        pendingToastId = toastManager.add(
          stackedThreadToast({ type: "loading", title: "Copying transcript…", timeout: 0 }),
        );
      }, PENDING_TOAST_DELAY_MS);
      const result = await fetchSnapshot({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      window.clearTimeout(pendingToastTimer);
      // A large transcript's clipboard write can itself take a moment, so the
      // pending toast stays up through the write and closes with its outcome.
      const closePendingToast = () => {
        if (pendingToastId !== null) {
          toastManager.close(pendingToastId);
        }
      };
      // Superseded while fetching — by a newer transcript copy or by anything
      // else the user copied — so that write owns the clipboard now. Drop this
      // result without writing or toasting.
      if (requestId !== latestRequestId || clipboardWriteEpoch() !== epochAtRequest) {
        closePendingToast();
        return;
      }
      if (result._tag === "Failure") {
        closePendingToast();
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
        closePendingToast();
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
        closePendingToast();
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Nothing to copy",
            description: "This thread has no messages yet.",
          }),
        );
        return;
      }
      copyToClipboard(transcript.text, {
        messageCount: transcript.messageCount,
        closePendingToast,
      });
    },
    [copyToClipboard, fetchSnapshot],
  );
}
