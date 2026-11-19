import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { ThreadRouteTarget } from "../../threadRoutes";

/** What the chat layout renders itself, so Settings and Usage can open over it. */
export type MainView =
  | { readonly kind: "thread"; readonly target: ThreadRouteTarget }
  | { readonly kind: "project"; readonly projectKey: string };

export function resolveMainView(
  thread: ThreadRouteTarget | null,
  projectKey: string | null,
): MainView | null {
  if (thread) return { kind: "thread", target: thread };
  return projectKey === null ? null : { kind: "project", projectKey };
}

function mainViewKey(view: MainView | null): string | null {
  if (view === null) return null;
  if (view.kind === "project") return `project:${view.projectKey}`;
  return view.target.kind === "server"
    ? scopedThreadKey(view.target.threadRef)
    : `draft:${view.target.draftId}`;
}

/** The view kept behind Settings or Usage: it follows the route only while they are closed. */
export function nextBackgroundView(
  previous: MainView | null,
  current: MainView | null,
  modalOpen: boolean,
): MainView | null {
  if (modalOpen) return previous;
  return mainViewKey(previous) === mainViewKey(current) ? previous : current;
}
