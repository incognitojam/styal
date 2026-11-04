import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import type {
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager, type ThreadToastData } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { openChangeRequestTab, openPullRequestLink } from "./openPullRequestLink";

interface ThreadPullRequests {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}

/** The pull request the sidebar shows for a thread, chosen the same way as its status chip. */
export function threadPullRequestUrl(
  thread: ThreadPullRequests,
  supportsLinks: boolean,
): string | null {
  const current = supportsLinks
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests ?? [])
    : null;
  if (current !== null) return current.url;
  return (
    (supportsLinks ? null : thread.linkedPullRequest?.url) ?? thread.branchPullRequest?.url ?? null
  );
}

export function readThreadPullRequestUrl(threadRef: ScopedThreadRef): string | null {
  const thread = readThreadShell(threadRef);
  if (thread === null) return null;
  const capabilities = appAtomRegistry
    .get(environmentServerConfigsAtom)
    .get(threadRef.environmentId)?.environment.capabilities;
  return threadPullRequestUrl(thread, capabilities?.threadPullRequests === true);
}

async function openInBrowser(threadRef: ScopedThreadRef, url: string | null) {
  const data: ThreadToastData = { threadRef };
  const api = readLocalApi();
  if (!api) {
    toastManager.add({ type: "error", title: "Link opening is unavailable.", data });
    return;
  }
  if (url === null) {
    toastManager.add({ type: "error", title: "This thread has no pull request.", data });
    return;
  }
  try {
    await openPullRequestLink(api.shell, url);
  } catch (error) {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open pull request link",
        description: error instanceof Error ? error.message : "An error occurred.",
        data,
      }),
    );
  }
}

/** Falls back to the browser when no project matches the repository or the host lacks the panel. */
export async function focusPullRequestTab(threadRef: ScopedThreadRef, url: string | null) {
  if (url !== null && openChangeRequestTab(threadRef, url)) return;
  await openInBrowser(threadRef, url);
}
