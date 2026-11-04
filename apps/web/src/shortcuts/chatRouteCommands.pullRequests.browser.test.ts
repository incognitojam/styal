import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import type { AnyRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  // Thread id -> the URL of its branch pull request.
  pullRequestByThread: {} as Record<string, string>,
  projects: [] as unknown[],
}));

vi.mock(import("../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  readThreadShell: ((ref: { threadId: string }) => {
    const url = state.pullRequestByThread[ref.threadId];
    return url === undefined ? null : { branchPullRequest: { url } };
  }) as never,
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

type Match = {
  readonly routeId: string;
  readonly pathname: string;
  readonly params?: Record<string, string>;
};

function routerAt(matches: Match[]) {
  const state = { matches: matches.map((match) => ({ params: {}, ...match })) };
  return {
    router: { state } as unknown as AnyRouter,
    navigate: (next: Match[]) => {
      state.matches = next.map((match) => ({ params: {}, ...match }));
    },
  };
}

const CHAT: Match[] = [
  { routeId: "__root__", pathname: "/" },
  { routeId: "/_chat", pathname: "/" },
];

const PROJECT = ProjectId.make("project");
const FIRST_PR = "https://github.com/owner/repo/pull/1";
const SECOND_PR = "https://github.com/owner/repo/pull/2";

function threadAt(threadId: string): Match[] {
  return [
    ...CHAT,
    {
      routeId: "/_chat/$environmentId/$threadId",
      pathname: `/environment/${threadId}`,
      params: { environmentId: "environment", threadId },
    },
  ];
}

function setup() {
  state.pullRequestByThread = { first: FIRST_PR, second: SECOND_PR };
  state.projects = [];
}

function press(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "h",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("pull request commands", () => {
  it("open the pull request of the thread on screen, and stay quiet under modal pages", () => {
    // No project holds owner/repo here, so each press falls back to the browser.
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    using open = vi.spyOn(window, "open").mockReturnValue(null);
    const { router, navigate } = routerAt(threadAt("first"));
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));

    press();
    expect(open.mock.calls).toEqual([[FIRST_PR, "_blank", "noopener,noreferrer"]]);

    navigate(threadAt("second"));
    press();
    expect(open.mock.calls.at(-1)?.[0]).toBe(SECOND_PR);

    navigate([...threadAt("second"), { routeId: "/_chat/settings", pathname: "/settings" }]);
    press();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("open nothing for a thread without a pull request", () => {
    setup();
    state.pullRequestByThread = {};
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    using open = vi.spyOn(window, "open").mockReturnValue(null);
    using openPullRequest = vi.spyOn(useRightPanelStore.getState(), "openPullRequest");
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(routerAt(threadAt("first")).router));

    press();

    expect(open).not.toHaveBeenCalled();
    expect(openPullRequest).not.toHaveBeenCalled();
  });

  it("open the pull request tab beside the thread when a project holds its repository", () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    using open = vi.spyOn(window, "open").mockReturnValue(null);
    using openPullRequest = vi
      .spyOn(useRightPanelStore.getState(), "openPullRequest")
      .mockImplementation(() => undefined);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(routerAt(threadAt("second")).router));

    // No project checks out owner/repo, so the tab has nothing to load and the browser opens it.
    press();
    expect(open.mock.calls.at(-1)?.[0]).toBe(SECOND_PR);
    expect(openPullRequest).not.toHaveBeenCalled();

    state.projects = [
      {
        id: PROJECT,
        environmentId: EnvironmentId.make("environment"),
        repositoryIdentity: {
          canonicalKey: "github.com/owner/repo",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
          provider: SourceControlProviderKind.make("github"),
          displayName: "owner/repo",
          owner: "owner",
          name: "repo",
        },
      },
    ];
    press();
    expect(openPullRequest).toHaveBeenCalledWith(
      { environmentId: "environment", threadId: "second" },
      expect.objectContaining({ projectId: PROJECT, number: 2, url: SECOND_PR }),
    );
    expect(open).toHaveBeenCalledTimes(1);
  });
});
