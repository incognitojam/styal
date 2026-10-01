import { useCallback, type MouseEvent } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";

import {
  BrowserPreviewUnavailableError,
  BrowserSettingsReadError,
  openUrlInPreview,
} from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "~/components/chat/externalLinkContextMenu";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { readThreadShell } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { usePullRequestLinking } from "./usePullRequestLinking";

/** Link actions shared by Markdown links and PR chips, scoped to their conversation. */
export function useExternalLinkContextMenu(threadRef?: ScopedThreadRef) {
  const pullRequestLinking = usePullRequestLinking(threadRef?.environmentId);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const openExternalLinkInPreview = useCallback(
    (url: string) => {
      if (!threadRef) {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({ message: "Thread context is unavailable." }),
            ),
          ),
        );
      }
      return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
        if (result._tag === "Success") recordVisitForThread(threadRef, url);
        else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          if (error instanceof BrowserSettingsReadError) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Unable to open link in browser",
                description: error.message,
              }),
            );
          }
        }
        return result;
      });
    },
    [openPreview, threadRef],
  );
  const onContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>, href: string) => {
      if (!resolveExternalWebLinkHost(href)) return;
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;
      // Read on invocation so a link/unlink elsewhere immediately changes the next menu.
      const thread = threadRef ? readThreadShell(threadRef) : null;
      const threadLinkAction = !thread
        ? undefined
        : pullRequestLinking.isLinked(thread, href)
          ? "unlink-from-thread"
          : pullRequestLinking.canLink(href)
            ? "link-to-thread"
            : undefined;
      void showExternalLinkContextMenu({
        href,
        canOpenInPreview: Boolean(threadRef) && isPreviewSupportedInRuntime(),
        threadLinkAction,
        position: { x: event.clientX, y: event.clientY },
        showContextMenu: (items, position) => api.contextMenu.show(items, position),
        openInPreview: async (target) => {
          const result = await openExternalLinkInPreview(target);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            throw squashAtomCommandFailure(result);
          }
        },
        openExternal: (target) => api.shell.openExternal(target),
        copyLink: (target) => writeTextToClipboard(target, "link"),
        updateThreadLink: async (target, linked) => {
          if (
            !threadRef ||
            (!linked && !pullRequestLinking.isLinked(readThreadShell(threadRef), target))
          )
            return;
          await pullRequestLinking.changeLink(threadRef, target, linked);
        },
        reportFailure: (operation, cause) => {
          console.error("[external-link] action failed", { operation, target: href }, cause);
          if (
            operation === "link-pull-request-to-thread" ||
            operation === "unlink-pull-request-from-thread"
          ) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  operation === "link-pull-request-to-thread"
                    ? "Unable to link pull request"
                    : "Unable to unlink pull request",
                description: cause instanceof Error ? cause.message : "The request failed.",
              }),
            );
          }
        },
      });
    },
    [openExternalLinkInPreview, pullRequestLinking, threadRef],
  );
  return { onContextMenu, openExternalLinkInPreview };
}
