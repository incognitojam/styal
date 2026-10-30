import type { EnvironmentId, LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type MouseEvent } from "react";

import {
  resolveChangeRequestLinkTarget,
  resolvePullRequestPreviewTarget,
} from "@t3tools/client-runtime/change-request-links";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { canOpenLinksInApp } from "../browser/browserLinkTarget";
import { useOpenLink } from "../browser/useOpenLink";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import {
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "../diffPanelStore";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readProjects, readThreadShell, useProjects } from "../state/entities";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";
import { reviewEnvironment } from "../state/review";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

export class PullRequestLinkOpenError extends Schema.TaggedError<PullRequestLinkOpenError>()(
  "PullRequestLinkOpenError",
  {
    targetOrigin: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(targetUrl: string, cause: unknown): PullRequestLinkOpenError {
    let targetOrigin: string | null = null;
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      // Keep malformed URLs out of diagnostics while preserving the open failure below.
    }
    return new PullRequestLinkOpenError({ targetOrigin, cause });
  }

  override get message(): string {
    return this.targetOrigin === null
      ? "Unable to open pull request link."
      : `Unable to open pull request link at ${this.targetOrigin}.`;
  }
}

export async function openPullRequestLink(
  shell: Pick<LocalApi["shell"], "openExternal">,
  targetUrl: string,
): Promise<void> {
  try {
    await shell.openExternal(targetUrl);
  } catch (cause) {
    throw PullRequestLinkOpenError.fromCause(targetUrl, cause);
  }
}

export function usePullRequestPreviewTarget(environmentId: EnvironmentId | null, url: string) {
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return resolvePullRequestPreviewTarget({
    environmentId,
    projects,
    pullRequestsEnabled: serverConfig !== null,
    url,
  });
}

function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey"> &
    Partial<Pick<MouseEvent<HTMLElement>, "button">>,
): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
}

function readChangeRequestLinkTarget(input: {
  readonly url: string;
  readonly environmentId: EnvironmentId | undefined;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly lendHostProject: boolean;
}) {
  // Read at click time: every provider status push replaces the config map, and
  // subscribing would hand every rendered link a new handler. Projects likewise, so a
  // link can resolve against a snapshot that arrived after this handler was built.
  const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
  return resolveChangeRequestLinkTarget({
    ...input,
    projects: readProjects(),
    configLoaded: (environmentId) => serverConfigs.has(environmentId),
  });
}

function openChangeRequestInPanel(
  panelRef: ScopedThreadRef,
  url: string,
  {
    project,
    repository,
    number,
    host,
  }: NonNullable<ReturnType<typeof readChangeRequestLinkTarget>>,
) {
  useRightPanelStore.getState().openPullRequest(panelRef, {
    // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
    ...(panelRef.environmentId === project.environmentId
      ? {}
      : { environmentId: project.environmentId }),
    projectId: project.id,
    ...(host === undefined ? {} : { host }),
    repository,
    url,
    number,
  });
}

/** {@link useOpenChangeRequestLink} for a thread's own tab, for handlers outside React. */
export function openChangeRequestTab(threadRef: ScopedThreadRef, url: string): boolean {
  if (!getClientSettings().pullRequestLinksOpenInApp) return false;
  const target = readChangeRequestLinkTarget({
    url,
    environmentId: threadRef.environmentId,
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    lendHostProject: true,
  });
  if (target === null) return false;
  openChangeRequestInPanel(threadRef, url, target);
  return true;
}

/**
 * Resolving the project here makes recognising a URL safe: a lookalike hostname matches no project
 * and stays an ordinary link. Given a thread, the link opens beside it in the right panel so the
 * reader keeps reading the thread.
 */
export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  > &
    Partial<Pick<MouseEvent<HTMLElement>, "button" | "shiftKey" | "altKey">>,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  targetEnvironmentId?: EnvironmentId,
  onCommitUnavailable?: () => void,
) => boolean {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  const ignoreWhitespace = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const browserLinkTarget = useClientSettings((settings) => settings.browserLinkTarget);
  const readDiffPreview = useAtomQueryRunner(reviewEnvironment.diffPreview, {
    reportFailure: false,
    refresh: true,
  });
  const openLink = useOpenLink(threadRef);
  return (event, targetUrl, targetThreadRef, targetEnvironmentId, onCommitUnavailable) => {
    if (!openInApp || shouldOpenPullRequestExternally(event)) return false;
    const resolvedThreadRef = targetThreadRef ?? threadRef;
    const resolvedPanelRef = panelRef ?? resolvedThreadRef;
    const openPullRequest = () => {
      const target = readChangeRequestLinkTarget({
        url: targetUrl,
        environmentId: resolvedThreadRef?.environmentId ?? targetEnvironmentId,
        primaryEnvironmentId,
        lendHostProject: resolvedPanelRef !== undefined,
      });
      if (target === null) return false;
      const { project, repository, number, host } = target;
      const pullRequestsSearch = {
        repository,
        number,
        ...(host === undefined ? {} : { selectedHost: host }),
        selectedProjectId: project.id,
        selectedEnvironmentId: project.environmentId,
      };
      if (resolvedPanelRef) {
        openChangeRequestInPanel(resolvedPanelRef, targetUrl, target);

        if (!resolvedThreadRef) {
          void navigate({
            to: "/pull-requests",
            search: (previous) => ({
              ...previous,
              involvement: previous.involvement ?? "all",
              state: previous.state ?? "all",
              ...pullRequestsSearch,
            }),
            replace: true,
          });
        }
        return true;
      }
      void navigate({
        to: "/pull-requests",
        search: { involvement: "all", state: "all", ...pullRequestsSearch },
      });
      return true;
    };
    const commitThread = resolvedThreadRef ? readThreadShell(resolvedThreadRef) : null;
    const commitProject =
      commitThread && resolvedThreadRef
        ? readProject({
            environmentId: resolvedThreadRef.environmentId,
            projectId: commitThread.projectId,
          })
        : null;
    const identity = commitProject?.repositoryIdentity;
    const parsedCommit = sourceControlClients.parseCommitUrl(targetUrl, identity?.provider);
    // Shift and Alt keep their browser meaning (new window, download) on commit links.
    if (parsedCommit !== null && (event.shiftKey || event.altKey)) return false;
    if (
      parsedCommit !== null &&
      commitThread &&
      resolvedThreadRef &&
      commitProject?.environmentId === resolvedThreadRef.environmentId &&
      identity &&
      identity.provider === parsedCommit.definition.kind &&
      parsedCommit.definition.isChangeRequestInRepository(identity, parsedCommit.link)
    ) {
      const commit = parsedCommit.link;
      event.preventDefault();
      event.stopPropagation();
      const userActionRevision = useRightPanelStore.getState().markUserAction(resolvedThreadRef);
      const baseRef = selectThreadBranchBaseRef(useDiffPanelStore.getState(), resolvedThreadRef);
      const selection = selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        resolvedThreadRef,
      );
      void readDiffPreview({
        environmentId: resolvedThreadRef.environmentId,
        input: {
          cwd: commitThread.worktreePath ?? commitProject.workspaceRoot,
          ...(baseRef ? { baseRef } : {}),
          commitSha: commit.sha,
          ignoreWhitespace,
        },
      })
        .then((result) => {
          if (
            useRightPanelStore.getState().getUserActionRevision(resolvedThreadRef) !==
              userActionRevision ||
            selectThreadDiffPanelSelection(
              useDiffPanelStore.getState().byThreadKey,
              resolvedThreadRef,
            ) !== selection
          )
            return;
          if (
            result._tag === "Success" &&
            result.value.sources.some(
              (source) => source.kind === "commit" && source.headRef === commit.sha,
            )
          ) {
            const diffOpen =
              selectActiveRightPanel(
                useRightPanelStore.getState().byThreadKey,
                resolvedThreadRef,
              ) === "diff";
            useDiffPanelStore.getState().selectCommit(resolvedThreadRef, commit.sha, !diffOpen);
            useRightPanelStore.getState().open(resolvedThreadRef, "diff");
            return;
          }
          if (openPullRequest()) return;
          if (onCommitUnavailable) return onCommitUnavailable();
          // A popup opened after the lookup has lost the click's activation, so browsers block it.
          if (
            window.desktopBridge === undefined &&
            (browserLinkTarget !== "app" || !canOpenLinksInApp(resolvedThreadRef))
          ) {
            const toastId = toastManager.add(
              stackedThreadToast({
                type: "info",
                title: "This commit is not in the thread's workspace",
                actionProps: {
                  children: "Open link",
                  onClick: () => {
                    toastManager.close(toastId);
                    window.open(targetUrl, "_blank", "noopener,noreferrer");
                  },
                },
              }),
            );
            return;
          }
          return openLink(targetUrl, {
            event: { metaKey: event.metaKey, ctrlKey: event.ctrlKey, button: event.button },
            threadRef: resolvedThreadRef,
          });
        })
        .catch((error: unknown) => console.error(error));
      return true;
    }
    if (!openPullRequest()) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
    if (event.button > 1) return false;
    event.stopPropagation();
    const openInBrowser = shouldOpenPullRequestExternally(event);
    const isAnchor =
      event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
    // Native links handle modified clicks; buttons still need openExternal.
    if (openInBrowser && isAnchor) return false;

    event.preventDefault();
    if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

    void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
    return false;
  };
}
