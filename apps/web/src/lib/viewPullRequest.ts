import { resolveChangeRequestLinkTarget } from "@t3tools/client-runtime/change-request-links";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import type {
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager, type ThreadToastData } from "../components/ui/toast";
import { getClientSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import { useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShell } from "../state/entities";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentServerConfigsAtom } from "../state/server";
import { openPullRequestLink } from "./openPullRequestLink";

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

function readServerCapabilities(environmentId: ScopedThreadRef["environmentId"]) {
  return appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
    .capabilities;
}

export function readThreadPullRequestUrl(threadRef: ScopedThreadRef): string | null {
  const thread = readThreadShell(threadRef);
  if (thread === null) return null;
  const supportsLinks =
    readServerCapabilities(threadRef.environmentId)?.threadPullRequests === true;
  return threadPullRequestUrl(thread, supportsLinks);
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

/** Opens the pull request as a tab beside the thread; false when it can only open in a browser. */
function openPullRequestTab(threadRef: ScopedThreadRef, url: string): boolean {
  if (!getClientSettings().pullRequestLinksOpenInApp) return false;
  const target = resolveChangeRequestLinkTarget({
    url,
    projects: readProjects(),
    capabilities: readServerCapabilities,
    environmentId: threadRef.environmentId,
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    lendHostProject: true,
  });
  if (target === null) return false;
  const { project, repository, number, host } = target;
  useRightPanelStore.getState().openPullRequest(threadRef, {
    ...(threadRef.environmentId === project.environmentId
      ? {}
      : { environmentId: project.environmentId }),
    projectId: project.id,
    ...(host === undefined ? {} : { host }),
    repository,
    url,
    number,
  });
  return true;
}

/** Falls back to the browser when no project matches the repository or the host lacks the panel. */
export async function focusPullRequestTab(threadRef: ScopedThreadRef, url: string | null) {
  if (url !== null && openPullRequestTab(threadRef, url)) return;
  await openInBrowser(threadRef, url);
}
