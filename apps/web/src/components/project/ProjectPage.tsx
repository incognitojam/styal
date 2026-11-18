import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
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
  useQuietThreadShell,
  useServerConfigs,
} from "../../state/entities";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { isThreadRouteSnapshotAuthoritative } from "../../threadRoutes";
import ChatView from "../ChatView";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { SidebarInset } from "../ui/sidebar";
import { projectChatDraftId, resolveProjectChatView } from "./projectPage.logic";
import { type ProjectPage as ProjectPageState, useProjectPages } from "./useProjectPages";

/** `/projects/<key>` with project coordinators on: the project's chat under its header. */
export function ProjectPage({ projectKey }: { projectKey: string }) {
  const page = useProjectPages().get(projectKey) ?? null;
  const group = useSettingsProjectGroups().find((entry) => entry.projectKey === projectKey);
  const projectsReady = useAllEnvironmentProjectSnapshotsReady();
  const serverConfigs = useServerConfigs();
  if (page !== null) return <ProjectChat key={projectKey} page={page} />;
  const settled =
    projectsReady &&
    (group === undefined ||
      group.memberProjects.every((member) => serverConfigs.has(member.environmentId)));
  return settled ? (
    <Navigate
      to="/settings/projects"
      search={{ project: projectKey, machine: undefined }}
      replace
    />
  ) : (
    <SidebarInset className="h-svh md:h-dvh" />
  );
}

function ProjectChat({ page }: { page: ProjectPageState }) {
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
      />
    ) : null;
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      {view}
    </SidebarInset>
  );
}
