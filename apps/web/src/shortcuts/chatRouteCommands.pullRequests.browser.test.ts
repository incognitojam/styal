import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import type { AnyRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pullRequestByThread: {} as Record<string, string>,
  projects: [] as unknown[],
}));

vi.mock(import("../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  readThreadShell: ((ref: { threadId: string }) => ({
    branchPullRequest: { url: state.pullRequestByThread[ref.threadId] },
  })) as never,
  readProjects: (() => state.projects) as never,
}));
vi.mock(import("../state/server"), async (importOriginal) => ({
  ...(await importOriginal()),
  primaryServerKeybindingsAtom: Atom.make(
    compileResolvedKeybindingsConfig([
      { key: "mod+alt+h", command: "sourceControl.focusPullRequestTab" },
    ]),
  ) as never,
  environmentServerConfigsAtom: Atom.make(
    new Map([["environment", { environment: { capabilities: { pullRequests: true } } }]]),
  ) as never,
}));

import { useRightPanelStore } from "../rightPanelStore";
import { installChatRouteCommands } from "./chatRouteCommands";

const PR = (number: number) => `https://github.com/owner/repo/pull/${number}`;
const PROJECT = {
  id: "project",
  environmentId: "environment",
  repositoryIdentity: {
    canonicalKey: "github.com/owner/repo",
    provider: "github",
    owner: "owner",
    name: "repo",
  },
};

const threadMatches = (threadId: string, pathname = `/environment/${threadId}`) => [
  { routeId: "/_chat", pathname: "/", params: {} },
  { routeId: "thread", pathname, params: { environmentId: "environment", threadId } },
];

function setup() {
  state.pullRequestByThread = { first: PR(1), second: PR(2) };
  state.projects = [PROJECT];
  const routerState = { matches: threadMatches("first") };
  const stack = new DisposableStack();
  stack.defer(installChatRouteCommands({ state: routerState } as unknown as AnyRouter));
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64"));
  return {
    stack,
    routerState,
    open: stack.use(vi.spyOn(window, "open").mockReturnValue(null)),
    openTab: stack.use(
      vi.spyOn(useRightPanelStore.getState(), "openPullRequest").mockReturnValue(undefined),
    ),
  };
}

function press() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "h", ctrlKey: true, altKey: true, cancelable: true }),
  );
}

it("opens the tab for the thread on screen, or the browser when no project holds its repository", () => {
  const { stack, routerState, open, openTab } = setup();
  using _stack = stack;

  routerState.matches = threadMatches("second");
  press();
  expect(openTab).toHaveBeenCalledExactlyOnceWith(
    { environmentId: "environment", threadId: "second" },
    expect.objectContaining({ projectId: "project", number: 2, url: PR(2) }),
  );
  expect(open).not.toHaveBeenCalled();

  state.projects = [];
  press();
  expect(open.mock.calls).toEqual([[PR(2), "_blank", "noopener,noreferrer"]]);
});

it("opens nothing without a pull request or under a modal page", () => {
  const { stack, routerState, open, openTab } = setup();
  using _stack = stack;

  routerState.matches = threadMatches("first", "/settings");
  press();

  state.pullRequestByThread = {};
  routerState.matches = threadMatches("first");
  press();

  expect(open).not.toHaveBeenCalled();
  expect(openTab).not.toHaveBeenCalled();
});
