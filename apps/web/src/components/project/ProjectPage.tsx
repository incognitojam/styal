import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  addSinceLastVisitEnvironment,
  type CapturedSinceLastVisit,
  captureSinceLastVisit,
} from "@t3tools/client-runtime/project-since-last-visit";
import { projectCoordinatorPatch } from "@t3tools/client-runtime/state/project-coordinators";
import { projectCoordinatorThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { DraftId, ensureProjectChatDraft, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { reportProjectCoordinatorFailure } from "../../hooks/useThreadActionMenu";
import { newThreadId } from "../../lib/utils";
import { useEnvironmentMachines, useEnvironments } from "../../state/environments";
import {
  useAllEnvironmentProjectSnapshotsReady,
  useEnvironmentShellStatuses,
  useQuietThreadShell,
  useServerConfigs,
} from "../../state/entities";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentThreadShells, olderSettledThreads } from "../../state/threads";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { isThreadRouteSnapshotAuthoritative } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { SidebarInset } from "../ui/sidebar";
import { projectChatDraftId, resolveProjectChatView } from "./projectPage.logic";
import { type ProjectPage as ProjectPageState, useProjectPages } from "./useProjectPages";

/**
 * `/projects/<key>` with project coordinators on: the project's chat under its header.
 * `background` keeps it mounted, inert and in place under Settings or Usage.
 */
export function ProjectPage({
  projectKey,
  background = false,
}: {
  projectKey: string;
  background?: boolean;
}) {
  const page = useProjectPages().get(projectKey) ?? null;
  const group = useSettingsProjectGroups().find((entry) => entry.projectKey === projectKey);
  const projectsReady = useAllEnvironmentProjectSnapshotsReady();
  const serverConfigs = useServerConfigs();
  if (page !== null) return <ProjectChat key={projectKey} page={page} background={background} />;
  const settled =
    projectsReady &&
    (group === undefined ||
      group.memberProjects.every((member) => serverConfigs.has(member.environmentId)));
  return settled && !background ? (
    <Navigate
      to="/settings/projects"
      search={{ project: projectKey, machine: undefined }}
      replace
    />
  ) : (
    <SidebarInset className="h-svh md:h-dvh" />
  );
}

function ProjectChat({ page, background }: { page: ProjectPageState; background: boolean }) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const { environments } = useEnvironments();
  const machines = useEnvironmentMachines();
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const { checkout, chatThreadId } = page.host;
  const environmentId = checkout.environmentId;
  const draftId = DraftId.make(projectChatDraftId(checkout));
  const chatRef = chatThreadId === null ? null : scopeThreadRef(environmentId, chatThreadId);
  const chatShell = useQuietThreadShell(chatRef);
  const shellLive = isThreadRouteSnapshotAuthoritative(useEnvironmentShellStatus(environmentId));
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const draftRedirect = useComposerDraftStore((store) => store.getPromotedDraftRedirect(draftId));
  const sentRef = draftSession?.promotedTo ?? draftRedirect;
  const sentShell = useQuietThreadShell(sentRef);
  const chat = chatShell !== null && chatShell.deletedAt == null ? chatRef : null;
  // Taken once from the chat's live shell, before the page records the visit; each machine's
  // threads are added once its own snapshot is live.
  const shellStatuses = useEnvironmentShellStatuses();
  const [sinceLastVisit, setSinceLastVisit] = useState<CapturedSinceLastVisit | null | undefined>();
  let nextSinceLastVisit = sinceLastVisit;
  if (nextSinceLastVisit === undefined && chat !== null && shellLive) {
    const liveChat = appAtomRegistry.get(environmentThreadShells.threadShellAtom(chat));
    // oxlint-disable-next-line react/purity -- read once per page view, when the capture is taken
    const openedAt = Date.now();
    nextSinceLastVisit = liveChat === null ? undefined : captureSinceLastVisit(liveChat, openedAt);
  }
  if (nextSinceLastVisit != null && chat !== null) {
    for (const member of page.group.memberProjects) {
      const memberEnvironment = member.environmentId;
      if (nextSinceLastVisit.environments.has(memberEnvironment)) continue;
      if (!isThreadRouteSnapshotAuthoritative(shellStatuses.get(memberEnvironment))) continue;
      nextSinceLastVisit = addSinceLastVisitEnvironment(nextSinceLastVisit, {
        environmentId: memberEnvironment,
        projectIds: new Set(
          page.group.memberProjects
            .filter((other) => other.environmentId === memberEnvironment)
            .map((other) => other.id),
        ),
        threads: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
        chatRef: chat,
        olderSettled: appAtomRegistry.get(olderSettledThreads.olderSettledAtom(memberEnvironment)),
      });
    }
  }
  if (nextSinceLastVisit !== sinceLastVisit) setSinceLastVisit(nextSinceLastVisit);
  // The draft's thread this page named as the chat, until the settings stream names it too.
  const [named, setNamed] = useState<ScopedThreadRef | null>(null);
  if (named !== null && chatThreadId === named.threadId) setNamed(null);
  const { show, openDraft } = resolveProjectChatView({
    shellLive,
    chat,
    draftOpen: draftSession !== null,
    draftSending: draftSession?.promotedTo != null,
    named:
      named !== null && sentShell !== null && sentRef?.threadId === named.threadId ? named : null,
  });
  // A sent draft's ChatView keeps its key while its thread stays on screen, so sending never remounts.
  const shownThreadId = show?.kind === "thread" ? show.ref.threadId : null;
  const [sentViewThreadId, setSentViewThreadId] = useState<string | null>(null);
  const nextSentViewThreadId =
    shownThreadId !== null &&
    (shownThreadId === sentViewThreadId || shownThreadId === sentRef?.threadId)
      ? shownThreadId
      : null;
  if (nextSentViewThreadId !== sentViewThreadId) setSentViewThreadId(nextSentViewThreadId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the chat's draft in the composer draft store, which the page cannot hold in render
  useEffect(() => {
    if (!openDraft) return;
    ensureProjectChatDraft({
      draftId,
      threadId: newThreadId(),
      projectRef: scopeProjectRef(environmentId, checkout.id),
      logicalProjectKey: page.group.projectKey,
    });
  }, [checkout.id, draftId, environmentId, openDraft, page.group.projectKey]);

  // Named before the first message is sent, so the chat's first turn is told it coordinates.
  const nameAsChat = async (threadRef: ScopedThreadRef) => {
    const result = await saveSettings({
      environmentId: threadRef.environmentId,
      input: { patch: projectCoordinatorPatch(checkout.id, threadRef.threadId) },
    });
    if (result._tag === "Success") setNamed(threadRef);
    else await reportProjectCoordinatorFailure(result);
    return result;
  };
  // The thread named before sending will never exist, so the project has no chat again.
  const unnameAsChat = (threadRef: ScopedThreadRef) => {
    setNamed(null);
    const settings = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(threadRef.environmentId)?.settings;
    if (!settings || projectCoordinatorThreadId(settings, checkout.id) !== threadRef.threadId)
      return;
    void saveSettings({
      environmentId: threadRef.environmentId,
      input: { patch: projectCoordinatorPatch(checkout.id, null) },
    }).then(reportProjectCoordinatorFailure);
  };

  const environmentLabel = environments.find(
    (entry) => entry.environmentId === environmentId,
  )?.label;
  const projectChat = {
    project: page.group,
    name: page.group.displayName,
    statusLine: page.statusLine,
    needYou: page.needYou,
    machine:
      environmentLabel === undefined
        ? null
        : { label: environmentLabel, kind: machines.get(environmentId) ?? "server" },
    onNewThread: () => void handleNewThread(scopeProjectRef(environmentId, checkout.id)),
    onOpenSettings: () =>
      void navigate({
        to: "/settings/projects",
        search: { project: page.group.projectKey, machine: undefined },
      }),
  } as const;

  const view =
    show === null ? null : show.kind === "draft" && draftSession !== null ? (
      <ChatView
        key={draftId}
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        projectChat={projectChat}
        beforeThreadCreate={nameAsChat}
        onThreadNotCreated={unnameAsChat}
        forceExpandedMobileComposer
      />
    ) : show.kind === "thread" ? (
      <ChatView
        key={nextSentViewThreadId === show.ref.threadId ? draftId : "project-chat"}
        environmentId={show.ref.environmentId}
        threadId={show.ref.threadId}
        routeKind="server"
        projectChat={projectChat}
        sinceLastVisit={sinceLastVisit ?? null}
        holdVisit={sinceLastVisit === undefined}
      />
    ) : null;
  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
    >
      <BackgroundThreadContext value={background}>{view}</BackgroundThreadContext>
    </SidebarInset>
  );
}
