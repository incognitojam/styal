import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countProjectThreads,
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
    expect(counts).toEqual({ working: 2, needYou: 3 });
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
    expect(counts).toEqual({ working: 1, needYou: 0 });
  });
});

describe("formatProjectStatusLine", () => {
  it("names working threads, then those needing you, and is empty when neither", () => {
    expect(formatProjectStatusLine({ working: 4, needYou: 2 })).toBe("4 working · 2 need you");
    expect(formatProjectStatusLine({ working: 0, needYou: 1 })).toBe("1 needs you");
    expect(formatProjectStatusLine({ working: 3, needYou: 0 })).toBe("3 working");
    expect(formatProjectStatusLine({ working: 0, needYou: 0 })).toBeNull();
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
      ),
    ).toEqual({ checkout: checkouts[1], chatThreadId: null });
    // Not created yet: still this project's chat, so its first turn is told.
    expect(
      resolveProjectChatHost(
        checkouts,
        () => stored,
        local,
        () => null,
      ),
    ).toEqual({
      checkout: checkouts[0],
      chatThreadId: chatId,
    });
  });

  it("puts a new chat on the primary machine, and an existing one where it is stored", () => {
    expect(
      resolveProjectChatHost(
        checkouts,
        () => on,
        local,
        () => null,
      ),
    ).toEqual({
      checkout: checkouts[1],
      chatThreadId: null,
    });
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
      ),
    ).toEqual({ checkout: checkouts[0], chatThreadId: chatId });
  });
});

describe("projectChatDraftId", () => {
  it("survives a reload: stored draft keys with a colon are read back as thread keys", () => {
    const draftId = projectChatDraftId({ environmentId: EnvironmentId.make("env:a"), id: project });
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
