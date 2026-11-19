import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countProjectThreads,
  staysOnProjectPage,
  formatProjectStatusLine,
  isProjectChatDraftId,
  projectChatDraftId,
  projectPageRouteDisabled,
  resolveProjectChatHost,
  resolveProjectChatView,
} from "./projectPage.logic";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const project = ProjectId.make("project-orchard");
const chatId = ThreadId.make("thread-chat");

function shell(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    environmentId: local,
    id: ThreadId.make(id),
    projectId: project,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    archivedAt: null,
    deletedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

const running = { status: "running" } as EnvironmentThreadShell["runtime"];

function ranking(
  input: {
    readonly at?: Partial<Record<string, string>>;
    readonly chatAt?: Partial<Record<string, string>>;
    readonly offline?: ReadonlyArray<string>;
  } = {},
) {
  const time = (value: string | undefined) =>
    value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return {
    checkoutActivityAt: (checkout: { readonly environmentId: string }) =>
      time(input.at?.[checkout.environmentId]),
    chatActivityAt: (_environmentId: string, threadId: string) => time(input.chatAt?.[threadId]),
    connected: (environmentId: string) => !input.offline?.includes(environmentId),
  };
}

describe("countProjectThreads", () => {
  it("counts approvals, questions and report questions as needing you, and failures as neither", () => {
    const counts = countProjectThreads(
      [
        shell("approval", { hasPendingApprovals: true }),
        shell("question", { hasPendingUserInput: true }),
        shell("report", { openReportQuestionCount: 1 }),
        shell("working-1", { runtime: running }),
        shell("working-2", {
          runtime: { status: "preparing" } as EnvironmentThreadShell["runtime"],
        }),
        shell("failed", { runtime: { status: "failed" } as EnvironmentThreadShell["runtime"] }),
        shell("guest", { pendingGuestMessageCount: 1 }),
      ],
      null,
    );
    expect(counts.working).toBe(2);
    expect(counts.needYou.map((thread) => thread.id)).toEqual(["approval", "question", "report"]);
  });

  it("leaves out the chat itself, subagents, side chats and archived threads", () => {
    const counts = countProjectThreads(
      [
        shell("thread-chat", { runtime: running }),
        shell("subagent", {
          runtime: running,
          lineage: {
            parentThreadId: chatId,
            relationshipToParent: "subagent",
            rootThreadId: chatId,
          },
        }),
        shell("side", {
          hasPendingUserInput: true,
          lineage: {
            parentThreadId: chatId,
            relationshipToParent: null,
            rootThreadId: chatId,
            sideChat: true,
          },
        }),
        shell("archived", { runtime: running, archivedAt: "2026-11-18T10:00:00.000Z" }),
        shell("listed", { runtime: running }),
      ],
      `${local}:${chatId}`,
    );
    expect(counts.working).toBe(1);
    expect(counts.needYou).toEqual([]);
  });
});

describe("staysOnProjectPage", () => {
  const chats = new Set([`${local}:${chatId}`]);
  const started = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
    shell(id, {
      reportTo: { threadId: chatId },
      source: { createdBy: "agent" } as EnvironmentThreadShell["source"],
      pinnedAt: null,
      latestUserAuthoredMessageAt: null,
      latestRun: null,
      ...overrides,
    });

  it("keeps a thread an agent started for the chat off the sidebar while it works or after it finished", () => {
    expect(staysOnProjectPage(started("working", { runtime: running }), chats)).toBe(true);
    expect(staysOnProjectPage(started("done"), chats)).toBe(true);
  });

  it("brings it back when it needs you, fails, is pinned or you write to it", () => {
    for (const thread of [
      started("approval", { hasPendingApprovals: true }),
      started("question", { hasPendingUserInput: true }),
      started("report", { openReportQuestionCount: 1 }),
      started("guest", { pendingGuestMessageCount: 1 }),
      started("failed", { runtime: { status: "failed" } as EnvironmentThreadShell["runtime"] }),
      started("failed-run", {
        latestRun: { status: "failed" } as EnvironmentThreadShell["latestRun"],
      }),
      started("pinned", { pinnedAt: "2026-11-18T10:00:00.000Z" }),
      started("written", { latestUserAuthoredMessageAt: "2026-11-18T10:00:00.000Z" }),
    ]) {
      expect([thread.id, staysOnProjectPage(thread, chats)]).toEqual([thread.id, false]);
    }
  });

  it("leaves threads a person or the project started, or that report elsewhere, in the sidebar", () => {
    const person = started("person", {
      source: { createdBy: "user" } as EnvironmentThreadShell["source"],
    });
    const elsewhere = started("elsewhere", { reportTo: { threadId: ThreadId.make("other") } });
    // Every thread created in the project reports to the chat; that alone does not say it started it.
    const inProject = started("in-project", {
      reportTo: { threadId: chatId, source: "project-coordinator" },
    });
    expect(staysOnProjectPage(inProject, chats)).toBe(false);
    const otherMachine = started("remote", { environmentId: remote });
    expect(staysOnProjectPage(person, chats)).toBe(false);
    expect(staysOnProjectPage(elsewhere, chats)).toBe(false);
    expect(staysOnProjectPage(otherMachine, chats)).toBe(false);
    expect(staysOnProjectPage(started("no-chat"), new Set())).toBe(false);
  });
});

describe("formatProjectStatusLine", () => {
  it("names working threads, then those needing you, and is empty when neither", () => {
    const needYou = (count: number) =>
      Array.from({ length: count }, (_, index) => shell(`${index}`));
    expect(formatProjectStatusLine({ working: 4, needYou: needYou(2) })).toBe(
      "4 working · 2 need you",
    );
    expect(formatProjectStatusLine({ working: 0, needYou: needYou(1) })).toBe("1 needs you");
    expect(formatProjectStatusLine({ working: 3, needYou: [] })).toBe("3 working");
    expect(formatProjectStatusLine({ working: 0, needYou: [] })).toBeNull();
  });
});

describe("project page availability", () => {
  const off = { projectCoordinatorsEnabled: false, projectCoordinators: {} };
  const on = { projectCoordinatorsEnabled: true, projectCoordinators: {} };
  const checkouts = [
    { environmentId: remote, id: project },
    { environmentId: local, id: project },
  ];

  it("keeps the settings redirect only once every machine has loaded with the switch off", () => {
    expect(projectPageRouteDisabled([off, off])).toBe(true);
    expect(projectPageRouteDisabled([off, on])).toBe(false);
    // A machine still loading may have it on: the page decides once the project's machines load.
    expect(projectPageRouteDisabled([off, null])).toBe(false);
    expect(projectPageRouteDisabled([])).toBe(false);
    expect(
      resolveProjectChatHost(
        checkouts,
        () => off,
        local,
        () => null,
        ranking(),
      ),
    ).toBeNull();
  });

  it("ignores a stored chat that is a thread of another project", () => {
    const stored = {
      projectCoordinatorsEnabled: true,
      projectCoordinators: { [project]: { threadId: chatId } },
    };
    const otherProject = ProjectId.make("project-elsewhere");
    expect(
      resolveProjectChatHost(
        checkouts,
        () => stored,
        local,
        () => otherProject,
        ranking(),
      ),
    ).toMatchObject({ checkout: checkouts[1], chatThreadId: null });
    // Not created yet: still this project's chat, so its first turn is told.
    expect(
      resolveProjectChatHost(
        checkouts,
        () => stored,
        local,
        () => null,
        ranking(),
      ),
    ).toMatchObject({
      checkout: checkouts[0],
      chatThreadId: chatId,
    });
  });

  it("puts a new chat on a connected machine where the project was last active, else the primary", () => {
    expect(
      resolveProjectChatHost(
        checkouts,
        () => on,
        local,
        () => null,
        ranking(),
      ),
    ).toEqual({
      checkout: checkouts[1],
      chatThreadId: null,
      choices: checkouts,
      off: [],
    });
    const lastActive = {
      [remote]: "2026-11-19T10:00:00.000Z",
      [local]: "2026-11-18T10:00:00.000Z",
    };
    expect(
      resolveProjectChatHost(
        checkouts,
        () => on,
        local,
        () => null,
        ranking({ at: lastActive }),
      ),
    ).toMatchObject({ checkout: checkouts[0] });
    // Activity cached from a machine that is not connected does not outrank a connected one.
    expect(
      resolveProjectChatHost(
        checkouts,
        () => on,
        local,
        () => null,
        ranking({ at: lastActive, offline: [remote] }),
      ),
    ).toMatchObject({ checkout: checkouts[1] });
    // A machine with project coordinators off cannot take the chat; it is listed as off.
    expect(
      resolveProjectChatHost(
        checkouts,
        (id) => (id === remote ? off : on),
        local,
        () => null,
        ranking({ at: { [remote]: "2026-11-19T10:00:00.000Z" } }),
      ),
    ).toEqual({
      checkout: checkouts[1],
      chatThreadId: null,
      choices: [checkouts[1]],
      off: [checkouts[0]],
    });
  });

  it("picks the most recently active chat when several machines name one", () => {
    const named = (threadId: string) => ({
      projectCoordinatorsEnabled: true,
      projectCoordinators: { [project]: { threadId: ThreadId.make(threadId) } },
    });
    expect(
      resolveProjectChatHost(
        checkouts,
        (id) => (id === remote ? named("stale-chat") : named("new-chat")),
        local,
        () => project,
        ranking({
          chatAt: {
            "new-chat": "2026-11-19T10:00:00.000Z",
            "stale-chat": "2026-11-01T10:00:00.000Z",
          },
        }),
      ),
    ).toEqual({ checkout: checkouts[1], chatThreadId: "new-chat", choices: [], off: [] });
  });

  it("keeps an existing chat where it is stored, with no choice left", () => {
    const stored = {
      projectCoordinatorsEnabled: true,
      projectCoordinators: { [project]: { threadId: chatId } },
    };
    expect(
      resolveProjectChatHost(
        checkouts,
        (id) => (id === remote ? stored : on),
        local,
        () => project,
        ranking(),
      ),
    ).toEqual({ checkout: checkouts[0], chatThreadId: chatId, choices: [], off: [] });
  });
});

describe("projectChatDraftId", () => {
  it("is one per project, and survives a reload: draft keys with a colon read back as thread keys", () => {
    const draftId = projectChatDraftId("env:a:~/work/orchard");
    expect(parseScopedThreadKey(draftId)).toBeNull();
    expect(isProjectChatDraftId(draftId)).toBe(true);
  });
});

describe("resolveProjectChatView", () => {
  const sent = { environmentId: local, threadId: ThreadId.make("thread-new") };
  const chat = { environmentId: local, threadId: chatId };
  const base = { shellLive: true, chat: null, draftOpen: false, draftSending: false, named: null };

  it("opens a draft only once the machine's threads are known and no chat exists", () => {
    expect(resolveProjectChatView({ ...base, shellLive: false }).openDraft).toBe(false);
    expect(resolveProjectChatView(base)).toEqual({ show: null, openDraft: true });
    expect(resolveProjectChatView({ ...base, chat })).toEqual({
      show: { kind: "thread", ref: chat },
      openDraft: false,
    });
  });

  it("keeps the first message's thread on screen until the settings name it", () => {
    // Sending: the draft stays, even once the settings already name the new thread.
    expect(
      resolveProjectChatView({ ...base, chat: sent, draftOpen: true, draftSending: true }).show,
    ).toEqual({ kind: "draft" });
    // Finalized before the settings stream caught up: the named thread shows, no second draft.
    expect(resolveProjectChatView({ ...base, named: sent })).toEqual({
      show: { kind: "thread", ref: sent },
      openDraft: false,
    });
  });

  it("follows the settings once the chat is cleared or another thread is chosen", () => {
    // Cleared after the first message: a fresh draft, not the old thread.
    expect(resolveProjectChatView(base).openDraft).toBe(true);
    // Another coordinator chosen while a draft sat unsent: it shows, the draft waits.
    expect(resolveProjectChatView({ ...base, chat, draftOpen: true })).toEqual({
      show: { kind: "thread", ref: chat },
      openDraft: false,
    });
  });
});
