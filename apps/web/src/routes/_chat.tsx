import { Outlet, createFileRoute, redirect, useMatches, useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { ProjectPage } from "../components/project/ProjectPage";
import { nextBackgroundView, resolveMainView } from "../components/sidebar/appModalBackground";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const projectKey = useParams({ strict: false, select: (params) => params.projectKey ?? null });
  const current = resolveMainView(threadTarget, projectKey);
  // Settings and Usage render over the thread or project page that opened them, so its
  // ChatView never remounts.
  const [background, setBackground] = useState(current);
  const nextBackground = nextBackgroundView(background, current, modalOpen);
  if (nextBackground !== background) setBackground(nextBackground);
  const shown = modalOpen ? nextBackground : current;
  return (
    <>
      {shown?.kind === "thread" && shown.target.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shown.target.threadRef} />
      ) : null}
      {shown?.kind === "thread" ? (
        <ThreadRouteView target={shown.target} background={modalOpen} />
      ) : shown?.kind === "project" ? (
        <ProjectPage projectKey={shown.projectKey} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
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
