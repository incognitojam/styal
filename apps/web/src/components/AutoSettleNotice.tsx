import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settleReasonSentence } from "@t3tools/client-runtime/state/thread-settled";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import {
  getLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "../hooks/useLocalStorage";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { resolveAutoSettleNotice } from "./AutoSettleNotice.logic";
import { SETTLED_SHELF_EXPANDED_KEY } from "./Sidebar.logic";
import { InlineButton } from "./ui/button";
import { toastManager } from "./ui/toast";

const SINCE_KEY = "styal:auto-settle-notice:v1:since";
const DISMISSED_KEY = "styal:auto-settle-notice:v1:dismissed";

type ToastId = ReturnType<typeof toastManager.add>;

/** When this device first ran a version with the notice; older settles are not explained. */
function readOrStartSince(): string | null {
  try {
    const stored = getLocalStorageItem(SINCE_KEY, Schema.String);
    if (stored !== null) return stored;
    const now = new Date().toISOString();
    setLocalStorageItem(SINCE_KEY, now, Schema.String);
    return now;
  } catch {
    return null;
  }
}

/**
 * Explains automatic settlement the first time this device sees it: one
 * persistent notice, shown until the user dismisses it or takes an action,
 * then never again on this device.
 */
export function AutoSettleNotice() {
  const navigate = useNavigate();
  const openPrLink = useOpenPrLink();
  const threads = useThreadShells();
  const [dismissed, setDismissed] = useLocalStorage(DISMISSED_KEY, false, Schema.Boolean);
  const [, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [since] = useState(readOrStartSince);
  const notice = useMemo(
    () => resolveAutoSettleNotice<EnvironmentThreadShell>({ threads, since, dismissed }),
    [dismissed, since, threads],
  );
  const active = useRef<{ readonly key: string; readonly id: ToastId } | null>(null);

  const noticeKey =
    notice === null
      ? null
      : notice.kind === "single"
        ? `single:${notice.thread.environmentId}:${notice.thread.id}`
        : `combined:${notice.threads.map((thread) => `${thread.environmentId}:${thread.id}`).join(",")}`;

  useEffect(() => {
    if (active.current?.key === noticeKey) return;
    if (active.current !== null) {
      toastManager.close(active.current.id);
      active.current = null;
    }
    if (notice === null || noticeKey === null) return;

    let id!: ToastId;
    const dismiss = () => {
      setDismissed(true);
      toastManager.close(id);
    };
    const openSettings = () => {
      dismiss();
      void navigate({
        to: "/settings/general",
        hash:
          notice.kind === "single" && notice.reason.kind === "inactivity"
            ? "auto-settle-inactive-threads"
            : "auto-settle-merged-threads",
      });
    };
    const toastData = {
      actionLayout: "stacked-end" as const,
      hideCopyButton: true,
      // Only the dismiss button: replacing the notice closes it without the user.
      onClose: () => setDismissed(true),
      secondaryActionProps: { children: "Change settings", onClick: openSettings },
      secondaryActionVariant: "ghost" as const,
    };

    if (notice.kind === "single") {
      const { thread, reason } = notice;
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const openThread = () => {
        dismiss();
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      };
      const openPullRequest = (event: MouseEvent<HTMLElement>, url: string) => {
        if (openPrLink(event, url, threadRef)) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          });
        }
      };
      id = toastManager.add({
        title: "Thread settled automatically",
        description: (
          <>
            {thread.title} settled{" "}
            {reason.kind === "pull_request" ? (
              <>
                because{" "}
                <InlineButton tone="muted" onClick={(event) => openPullRequest(event, reason.url)}>
                  PR #{reason.number}
                </InlineButton>{" "}
                {reason.state}
              </>
            ) : (
              settleReasonSentence(reason)
            )}
            .
          </>
        ),
        timeout: 0,
        actionProps: { children: "Open thread", onClick: openThread },
        data: toastData,
      });
    } else {
      const viewSettled = () => {
        dismiss();
        setSettledShelfExpanded(true);
      };
      id = toastManager.add({
        title: `${notice.threads.length} threads settled automatically`,
        description: "They moved to the Settled shelf in the sidebar.",
        timeout: 0,
        actionProps: { children: "View", onClick: viewSettled },
        data: toastData,
      });
    }
    active.current = { key: noticeKey, id };
  }, [navigate, notice, noticeKey, openPrLink, setDismissed, setSettledShelfExpanded]);

  useEffect(
    () => () => {
      if (active.current === null) return;
      toastManager.close(active.current.id);
      // A remount, such as Strict Mode's effect replay, shows the notice again.
      active.current = null;
    },
    [],
  );

  return null;
}
