import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { readThreadShortcutContext } from "../shortcuts/chatRouteCommands";
import { registerCommands } from "../shortcuts/dispatcher";
import { useProjects, useQuietThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { createViewPullRequest, useFocusPullRequestTab } from "~/lib/viewPullRequest";

/** Opens the shown thread's pull request; mounted to keep its branch status subscribed. */
function ChatRoutePullRequestShortcuts() {
  const routeTarget = useThreadRouteTarget();
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const projects = useProjects();
  const activeProject = activeThread
    ? (projects.find(
        (project) =>
          project.environmentId === activeThread.environmentId &&
          project.id === activeThread.projectId,
      ) ?? null)
    : null;
  const gitCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot ?? null;
  const gitStatusQuery = useEnvironmentQuery(
    routeThreadRef && gitCwd
      ? vcsEnvironment.status({
          environmentId: routeThreadRef.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const { viewPullRequest } = createViewPullRequest(gitStatusQuery.data, routeThreadRef);
  const { focusPullRequestTab } = useFocusPullRequestTab(gitStatusQuery.data, routeThreadRef);
  const readContext = useEffectEvent(() => readThreadShortcutContext(routeThreadRef));
  const runViewPullRequest = useEffectEvent(() => void viewPullRequest());
  const runFocusPullRequestTab = useEffectEvent(() => void focusPullRequestTab());
  useEffect(
    () =>
      registerCommands(
        {
          "sourceControl.viewPullRequest": (event) => {
            event.preventDefault();
            event.stopPropagation();
            runViewPullRequest();
          },
          "sourceControl.focusPullRequestTab": (event) => {
            event.preventDefault();
            event.stopPropagation();
            runFocusPullRequestTab();
          },
        },
        { when: () => !isCommandPaletteOpen(), context: () => readContext() },
      ),
    [],
  );
  return null;
}

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
      {modalOpen ? null : <ChatRoutePullRequestShortcuts />}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
