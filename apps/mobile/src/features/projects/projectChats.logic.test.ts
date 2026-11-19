import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HomeProjectScope } from "../home/homeThreadList";
import { buildProjectChats, resolveProjectLink } from "./projectChats.logic";

const laptop = EnvironmentId.make("env-laptop");
const server = EnvironmentId.make("env-server");
const onLaptop = ProjectId.make("harbor-laptop");
const onServer = ProjectId.make("harbor-server");

function project(environmentId: EnvironmentId, id: ProjectId) {
  return { environmentId, id, title: "Harbor Notes" } as EnvironmentProject;
}

// One project checked out on two machines, as the thread list groups it.
const scope: HomeProjectScope = {
  key: "repo:harbor-notes",
  title: "Harbor Notes",
  representative: project(laptop, onLaptop),
  projects: [project(laptop, onLaptop), project(server, onServer)],
  projectRefs: [
    { environmentId: laptop, projectId: onLaptop },
    { environmentId: server, projectId: onServer },
  ],
  pinned: false,
  archived: false,
};

function shell(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
) {
  return {
    environmentId,
    projectId,
    id: ThreadId.make(id),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    archivedAt: null,
    deletedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    createdAt: "2026-11-19T08:00:00.000Z",
    updatedAt: "2026-11-19T08:00:00.000Z",
    ...overrides,
  } as EnvironmentThreadShell;
}

const running = { status: "running" } as EnvironmentThreadShell["runtime"];
const chatOn = (threadId: string) => ({
  projectCoordinatorsEnabled: true,
  projectCoordinators: { [onServer]: { threadId: ThreadId.make(threadId) } },
});

describe("buildProjectChats", () => {
  const threads = [
    shell(server, onServer, "chat", { runtime: running }),
    shell(server, onServer, "queue", { runtime: running }),
    shell(laptop, onLaptop, "tags", { hasPendingUserInput: true }),
    shell(laptop, onLaptop, "share"),
  ];

  it("finds the chat on the machine that names it and counts the project's other threads on every machine", () => {
    const chats = buildProjectChats({
      scopes: [scope],
      threads,
      settingsFor: (id) =>
        id === server
          ? chatOn("chat")
          : { projectCoordinatorsEnabled: true, projectCoordinators: {} },
      connected: () => true,
    });

    const chat = chats.byChatKey.get(`${server}:chat`);
    expect(chat).toMatchObject({
      scopeKey: scope.key,
      title: "Harbor Notes",
      projectId: onServer,
      working: 1,
      statusLine: "1 working · 1 needs you",
    });
    expect(chats.byScopeKey.get(scope.key)).toBe(chat);
    // A link to either checkout opens the same chat.
    expect(chats.byCheckoutKey.get(`${laptop}:${onLaptop}`)).toBe(chat);
    expect(chats.byCheckoutKey.get(`${server}:${onServer}`)).toBe(chat);
  });

  it("has no chat while project coordinators are off, or before the named thread is listed", () => {
    expect(
      buildProjectChats({
        scopes: [scope],
        threads,
        settingsFor: () => ({ ...chatOn("chat"), projectCoordinatorsEnabled: false }),
        connected: () => true,
      }).byChatKey.size,
    ).toBe(0);
    expect(
      buildProjectChats({
        scopes: [scope],
        threads,
        settingsFor: (id) => (id === server ? chatOn("not-listed-yet") : undefined),
        connected: () => true,
      }).byChatKey.size,
    ).toBe(0);
  });
});

describe("resolveProjectLink", () => {
  const settled = {
    chat: undefined,
    environmentSaved: true,
    connected: true,
    shellLive: true,
    shellCacheRead: true,
  };

  it("opens the chat, waits while the machine's threads load, and otherwise falls back to the list", () => {
    const chat = buildProjectChats({
      scopes: [scope],
      threads: [shell(server, onServer, "chat")],
      settingsFor: (id) => (id === server ? chatOn("chat") : undefined),
      connected: () => true,
    }).byChatKey.get(`${server}:chat`);
    expect(resolveProjectLink({ ...settled, chat, shellLive: false })).toBe("chat");
    expect(resolveProjectLink(settled)).toBe("list");
    expect(resolveProjectLink({ ...settled, environmentSaved: false, shellLive: false })).toBe(
      "list",
    );
    expect(resolveProjectLink({ ...settled, shellLive: false })).toBe("wait");
    // An offline machine settles on what it had cached.
    expect(resolveProjectLink({ ...settled, connected: false, shellLive: false })).toBe("list");
    expect(
      resolveProjectLink({ ...settled, connected: false, shellLive: false, shellCacheRead: false }),
    ).toBe("wait");
  });
});
