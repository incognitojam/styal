import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";

import { readLocalApi } from "../localApi";
import { openPullRequestLink, useOpenChangeRequestLink } from "./openPullRequestLink";
import { stackedThreadToast, toastManager, type ThreadToastData } from "../components/ui/toast";

export function createViewPullRequest(
  gitStatus: VcsStatusResult | null,
  threadRef: ScopedThreadRef | null,
) {
  const threadToastData: ThreadToastData | undefined = threadRef ? { threadRef } : undefined;
  const pullRequestUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;

  const viewPullRequest = async () => {
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
  };

  return { canViewPullRequest: pullRequestUrl !== null, viewPullRequest };
}

/**
 * Opens the thread's open change request as a right-panel tab, falling back to the browser when
 * the environment lacks the pull-request capability or no project matches the repository.
 */
export function useFocusPullRequestTab(
  gitStatus: VcsStatusResult | null,
  threadRef: ScopedThreadRef | null,
) {
  const { canViewPullRequest, viewPullRequest } = createViewPullRequest(gitStatus, threadRef);
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef ?? undefined);
  const pullRequestUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;

  const focusPullRequestTab = async () => {
    if (pullRequestUrl !== null) {
      // A shortcut is not a click: the modifiers that would send a click to the browser are
      // never held here, so the tab is what this opens.
      const inertEvent = {
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
        metaKey: false,
        ctrlKey: false,
      };
      if (openChangeRequestLink(inertEvent, pullRequestUrl)) return;
    }
    await viewPullRequest();
  };

  return { canFocusPullRequestTab: canViewPullRequest, focusPullRequestTab };
}
