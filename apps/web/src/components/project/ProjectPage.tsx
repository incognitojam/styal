import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  addSinceLastVisitEnvironment,
  type CapturedSinceLastVisit,
  captureSinceLastVisit,
} from "@t3tools/client-runtime/project-since-last-visit";
import { projectCoordinatorPatch } from "@t3tools/client-runtime/state/project-coordinators";
import {
  type EnvironmentId,
  projectCoordinatorThreadId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
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
  useProject,
  useQuietThreadShell,
  useServerConfigs,
} from "../../state/entities";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentThreadShells, olderSettledThreads } from "../../state/threads";
import { useProjectClone } from "../../state/projectClones";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams, isThreadRouteSnapshotAuthoritative } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { SidebarInset } from "../ui/sidebar";
import {
  legacyProjectChatDraftId,
  projectChatDraftId,
  resolveProjectChatView,
} from "./projectPage.logic";
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
  const { chatThreadId, choices, off } = page.host;
  // A draft saved per checkout, before drafts were kept per project, stays the draft while any of
  // it remains (its session or its sent redirect), so a failed first send recovers into it.
  const legacyDraftId = useComposerDraftStore((store) =>
    store.getDraftSession(DraftId.make(projectChatDraftId(page.group.projectKey))) !== null
      ? null
      : (page.group.memberProjects
          .map((member) => DraftId.make(legacyProjectChatDraftId(member)))
          .find(
            (id) =>
              store.getDraftSession(id) !== null || store.getPromotedDraftRedirect(id) !== null,
          ) ?? null),
  );
  const draftId = legacyDraftId ?? DraftId.make(projectChatDraftId(page.group.projectKey));
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  // Until the chat exists, its first message goes to the machine chosen in the composer.
  const checkout =
    (chatThreadId === null
      ? choices.find(
          (choice) =>
            choice.environmentId === draftSession?.environmentId &&
            choice.id === draftSession.projectId,
        )
      : undefined) ?? page.host.checkout;
  const environmentId = checkout.environmentId;
  const chatRef = chatThreadId === null ? null : scopeThreadRef(environmentId, chatThreadId);
  const chatShell = useQuietThreadShell(chatRef);
  const shellLive = isThreadRouteSnapshotAuthoritative(useEnvironmentShellStatus(environmentId));
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

  // A draft left on a machine that can no longer take the chat (project coordinators turned off
  // there, or the checkout gone from the project) moves to the default, so the first message
  // never starts there. A machine whose settings have not loaded yet keeps its draft.
  const isDraftCheckout = (member: { readonly environmentId: string; readonly id: string }) =>
    member.environmentId === draftSession?.environmentId && member.id === draftSession.projectId;
  const unsentDraft =
    chatThreadId === null && draftSession?.promotedTo == null ? draftSession : null;
  // A machine the project was just added to keeps the draft while it clones and until its
  // repository is known, when the checkout joins the project.
  const unsentDraftRef = unsentDraft
    ? scopeProjectRef(unsentDraft.environmentId, unsentDraft.projectId)
    : null;
  const draftClone = useProjectClone(unsentDraftRef);
  const draftProject = useProject(unsentDraftRef);
  const draftJoining =
    unsentDraftRef !== null &&
    !page.group.memberProjects.some(isDraftCheckout) &&
    (draftClone !== null || (draftProject !== null && draftProject.repositoryIdentity == null));
  const draftOffChoices =
    unsentDraft !== null &&
    !draftJoining &&
    (off.some(isDraftCheckout) || !page.group.memberProjects.some(isDraftCheckout));
  const hostRef =
    draftJoining && unsentDraftRef ? unsentDraftRef : scopeProjectRef(environmentId, checkout.id);
  const machineId = hostRef.environmentId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens or moves the chat's draft in the composer draft store, which the page cannot hold in render
  useEffect(() => {
    if (draftOffChoices) {
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(environmentId, checkout.id),
        environmentSelection: "manual",
      });
      return;
    }
    if (!openDraft) return;
    ensureProjectChatDraft({
      draftId,
      threadId: newThreadId(),
      projectRef: scopeProjectRef(environmentId, checkout.id),
      logicalProjectKey: page.group.projectKey,
    });
  }, [checkout.id, draftId, draftOffChoices, environmentId, openDraft, page.group.projectKey]);
  const labelOf = (machine: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === machine)?.label ?? machine;

  // The draft's own checkout: a project can have two checkouts on one machine.
  const projectOn = (machine: EnvironmentId) => {
    const draft = useComposerDraftStore.getState().getDraftSession(draftId);
    if (draft?.environmentId === machine) return draft.projectId;
    return (
      page.group.memberProjects.find((member) => member.environmentId === machine)?.id ??
      checkout.id
    );
  };
  // Named before the first message is sent, so the chat's first turn is told it coordinates.
  // One chat per project: the project's other machines stop naming theirs.
  const nameAsChat = async (threadRef: ScopedThreadRef) => {
    const result = await saveSettings({
      environmentId: threadRef.environmentId,
      input: {
        patch: projectCoordinatorPatch(projectOn(threadRef.environmentId), threadRef.threadId),
      },
    });
    if (result._tag !== "Success") {
      await reportProjectCoordinatorFailure(result);
      return result;
    }
    setNamed(threadRef);
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    for (const member of page.group.memberProjects) {
      const settings = configs.get(member.environmentId)?.settings;
      // Stored even where the switch is off: turning it on would bring that chat back.
      if (
        member.environmentId === threadRef.environmentId ||
        !settings ||
        !Object.hasOwn(settings.projectCoordinators, member.id)
      )
        continue;
      void saveSettings({
        environmentId: member.environmentId,
        input: { patch: projectCoordinatorPatch(member.id, null) },
      }).then(reportProjectCoordinatorFailure);
    }
    return result;
  };
  // The thread named before sending will never exist, so the project has no chat again.
  const unnameAsChat = (threadRef: ScopedThreadRef) => {
    setNamed(null);
    const settings = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(threadRef.environmentId)?.settings;
    const projectId = projectOn(threadRef.environmentId);
    if (!settings || projectCoordinatorThreadId(settings, projectId) !== threadRef.threadId) return;
    void saveSettings({
      environmentId: threadRef.environmentId,
      input: { patch: projectCoordinatorPatch(projectId, null) },
    }).then(reportProjectCoordinatorFailure);
  };

  const environmentLabel = environments.find((entry) => entry.environmentId === machineId)?.label;
  const projectChat = {
    project: page.group,
    name: page.group.displayName,
    statusLine: page.statusLine,
    needYou: page.needYou,
    machine:
      environmentLabel === undefined
        ? null
        : { label: environmentLabel, kind: machines.get(machineId) ?? "server" },
    newChatMachines:
      chatThreadId === null
        ? {
            environmentIds: [
              ...choices.map((choice) => choice.environmentId),
              ...(machineId === environmentId ? [] : [machineId]),
            ],
            offLabels: off.map((member) => labelOf(member.environmentId)),
          }
        : null,
    onNewThread: () => void handleNewThread(hostRef),
    onOpenSettings: () =>
      void navigate({
        to: "/settings/projects",
        search: { project: page.group.projectKey, machine: undefined },
      }),
    jobs: page.jobs,
    onOpenJobThread: (thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId }) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      }),
    onOpenThread:
      chat === null
        ? null
        : () =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(chat),
              search: { view: "thread" },
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
