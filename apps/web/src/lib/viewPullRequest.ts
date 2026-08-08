import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { readLocalApi } from "../localApi";
import { openPullRequestLink } from "./openPullRequestLink";
import { stackedThreadToast, toastManager, type ThreadToastData } from "../components/ui/toast";

export function useViewPullRequest(
  gitStatus: VcsStatusResult | null,
  threadRef: ScopedThreadRef | null,
) {
  const threadToastData = useMemo<ThreadToastData | undefined>(
    () => (threadRef ? { threadRef } : undefined),
    [threadRef],
  );
  const pullRequestUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;

  const viewPullRequest = useCallback(async () => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    if (!pullRequestUrl) {
      toastManager.add({
        type: "error",
        title: "No open pull request found.",
        data: threadToastData,
      });
      return;
    }
    try {
      await openPullRequestLink(api.shell, pullRequestUrl);
    } catch (error) {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    }
  }, [pullRequestUrl, threadToastData]);

  return { canViewPullRequest: pullRequestUrl !== null, viewPullRequest };
}
