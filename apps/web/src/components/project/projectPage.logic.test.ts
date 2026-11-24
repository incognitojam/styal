import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  type ScheduledTaskThread,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assistantCitationRoute } from "../../lib/assistantCitationNavigation";
import { heldOpenThreadKey } from "../../threadRoutes";
import {
  coordinatedProjectKey,
  isProjectPageJob,
  jobThreadStates,
  projectJobStatus,
  staysOnProjectPage,
  isProjectChatDraftId,
  projectChatDraftId,
  resolveProjectChatView,
  threadRouteProjectKey,
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

describe("jobThreadStates", () => {
  const task = (id: string, overrides: Partial<ScheduledTaskThread> = {}): ScheduledTaskThread => ({
    id: id as ScheduledTaskThread["id"],
    title: id,
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    threadId: ThreadId.make(`thread-${id}`),
    createdAt: "2026-11-01T09:00:00.000Z",
    nextRunAt: "2026-11-20T10:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: "never",
    ...overrides,
  });
  const once = { type: "once", runAt: "2026-11-19T09:00:00.000Z" } as const;

  it("counts from a thread's latest run, or before any run from when its latest task was made", () => {
    const shared = ThreadId.make("thread-shared");
    expect(
      jobThreadStates([
        task("new"),
        task("daily", { threadId: shared, lastRunAt: "2026-11-19T09:00:00.000Z" }),
        task("hourly", { threadId: shared, lastRunAt: "2026-11-20T08:00:00.000Z" }),
      ]),
    ).toEqual(
      new Map([
        [
          ThreadId.make("thread-new"),
          { since: Date.parse("2026-11-01T09:00:00.000Z"), dispatchFailed: false },
        ],
        [shared, { since: Date.parse("2026-11-20T08:00:00.000Z"), dispatchFailed: false }],
      ]),
    );
  });

  it("leaves out paused, blocked and finished one-time tasks, but not webhooks or a run in progress", () => {
    const since = jobThreadStates([
      task("paused", { enabled: false }),
      task("blocked", { blockedByPolicy: "Webhooks are off." }),
      task("ran-once", { schedule: once, nextRunAt: null, lastRunStatus: "succeeded" }),
      task("running-once", { schedule: once, nextRunAt: null, lastRunStatus: "running" }),
      task("webhook", { schedule: { type: "webhook", signature: null }, nextRunAt: null }),
    ]);
    expect([...since.keys()]).toEqual(["thread-running-once", "thread-webhook"]);
  });

  it("shows a genuine dispatch failure until success, including a retry or another bound task", () => {
    const job = shell("thread-dispatch", {
      source: { createdBy: "user" } as EnvironmentThreadShell["source"],
      reportTo: null,
    });
    for (const [status, retryFailure, visible] of [
      ["failed", undefined, true],
      ["running", true, true],
      ["succeeded", false, false],
      ["never", undefined, false],
    ] as const) {
      const tasks = [
        task("dispatch", {
          lastRunStatus: status,
          ...(retryFailure === undefined ? {} : { dispatchFailed: retryFailure }),
        }),
      ];
      const states = new Map(
        [...jobThreadStates(tasks)].map(([id, state]) => [`${local}:${id}`, state]),
      );
      expect([status, staysOnProjectPage(job, new Set(), states)]).toEqual([status, !visible]);
    }
    const shared = ThreadId.make("thread-dispatch");
    for (const overrides of [
      {},
      { enabled: false },
      { blockedByPolicy: "Webhooks off" },
      { schedule: once, nextRunAt: null },
    ]) {
      const broken = task("broken", { threadId: shared, lastRunStatus: "failed", ...overrides });
      const healthy = task("healthy", { threadId: shared, lastRunStatus: "succeeded" });
      for (const tasks of [[broken], [broken, healthy], [healthy, broken]]) {
        const states = jobThreadStates(tasks);
        const scoped = new Map([...states].map(([id, state]) => [`${local}:${id}`, state]));
        const launched = {
          ...job,
          source: { createdBy: "agent" } as EnvironmentThreadShell["source"],
          reportTo: { threadId: chatId },
        };
        expect(staysOnProjectPage(job, new Set(), scoped)).toBe(false);
        expect(staysOnProjectPage(launched, new Set([`${local}:${chatId}`]), scoped)).toBe(false);
      }
    }
  });

  it("shows a failed agent run rather than only its accepted dispatch", () => {
    for (const status of ["completed", "failed"] as const) {
      const thread = shell("thread-dispatch", {
        latestRun: { status } as EnvironmentThreadShell["latestRun"],
      });
      expect(projectJobStatus(thread, task("dispatch", { lastRunStatus: "succeeded" }))).toBe(
        status === "failed" ? "Run failed" : "Dispatched",
      );
    }
  });
});

describe("isProjectPageJob", () => {
  const settings = {
    projectCoordinatorsEnabled: true,
    projectCoordinators: { [project]: { threadId: chatId } },
  };
  const page = { archived: false };
  const jobs = new Map([
    [ThreadId.make("job"), { since: 0, dispatchFailed: false }],
    [chatId, { since: 0, dispatchFailed: false }],
  ]);

  it("keeps a scheduled task's thread in a project with a page, but not the chat or other threads", () => {
    expect(isProjectPageJob(shell("job"), jobs, settings, page)).toBe(true);
    expect(isProjectPageJob(shell(chatId), jobs, settings, page)).toBe(false);
    expect(isProjectPageJob(shell("other"), jobs, settings, page)).toBe(false);
  });

  it("leaves it alone in Scratch, an archived project, or before settings or the project load", () => {
    for (const group of [{ isScratch: true, archived: false }, { archived: true }, undefined]) {
      expect(isProjectPageJob(shell("job"), jobs, settings, group)).toBe(false);
    }
    expect(isProjectPageJob(shell("job"), jobs, undefined, page)).toBe(false);
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

  it("keeps a scheduled task's thread off the sidebar, whoever made the task", () => {
    const job = started("job", {
      reportTo: null,
      source: { createdBy: "user" } as EnvironmentThreadShell["source"],
      runtime: running,
    });
    expect(
      staysOnProjectPage(
        job,
        new Set(),
        new Map([[`${local}:job`, { since: 0, dispatchFailed: false }]]),
      ),
    ).toBe(true);
    expect(
      staysOnProjectPage(
        job,
        new Set(),
        new Map([[`${remote}:job`, { since: 0, dispatchFailed: false }]]),
      ),
    ).toBe(false);
  });

  it("keeps a scheduled task's thread despite what the person wrote before its latest run", () => {
    const handMade = started("hand-made", {
      reportTo: null,
      source: { createdBy: "user" } as EnvironmentThreadShell["source"],
      latestUserAuthoredMessageAt: "2026-11-01T10:00:00.000Z",
    });
    const latestRun = new Map([
      [
        `${local}:hand-made`,
        { since: Date.parse("2026-11-19T09:00:00.000Z"), dispatchFailed: false },
      ],
    ]);
    expect(staysOnProjectPage(handMade, new Set(), latestRun)).toBe(true);
  });

  it("brings a scheduled task's thread back for a message after its latest run, until the next run", () => {
    const written = started("written", {
      reportTo: null,
      latestUserAuthoredMessageAt: "2026-11-19T10:00:00.000Z",
    });
    const since = (at: string) =>
      new Map([[`${local}:written`, { since: Date.parse(at), dispatchFailed: false }]]);
    expect(staysOnProjectPage(written, new Set(), since("2026-11-19T09:00:00.000Z"))).toBe(false);
    expect(staysOnProjectPage(written, new Set(), since("2026-11-19T11:00:00.000Z"))).toBe(true);
  });

  it("brings it, or a scheduled task's thread, back when it needs you, fails, is pinned or you write to it", () => {
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
      const job = { ...thread, reportTo: null };
      const jobs = new Map([[`${local}:${thread.id}`, { since: 0, dispatchFailed: false }]]);
      expect([thread.id, staysOnProjectPage(job, new Set(), jobs)]).toEqual([thread.id, false]);
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

describe("coordinatedProjectKey", () => {
  const named = (threadId: ThreadId | null, enabled = true) => ({
    projectCoordinatorsEnabled: enabled,
    projectCoordinators: threadId === null ? {} : { [project]: { threadId } },
  });
  const group = (extra: object = {}) => ({
    projectKey: "orchard-key",
    isScratch: false,
    archived: false,
    memberProjects: [
      { environmentId: local, id: project },
      { environmentId: remote, id: project },
    ],
    ...extra,
  });
  const thread = { environmentId: local, threadId: chatId, projectId: project };

  it("names the project page a coordinator's thread address opens", () => {
    expect(
      coordinatedProjectKey(
        thread,
        (id) => (id === local ? named(chatId) : named(null)),
        () => group(),
      ),
    ).toBe("orchard-key");
  });

  it("leaves the thread view where the page would not show this thread", () => {
    const settingsFor = (id: string) => (id === local ? named(chatId) : named(null));
    expect(
      coordinatedProjectKey({ ...thread, threadId: ThreadId.make("other") }, settingsFor, () =>
        group(),
      ),
    ).toBeNull();
    // Named for this project but a thread of another one: not this project's chat.
    expect(
      coordinatedProjectKey(
        { ...thread, projectId: ProjectId.make("elsewhere") },
        settingsFor,
        () => group(),
      ),
    ).toBeNull();
    expect(
      coordinatedProjectKey(
        thread,
        () => named(chatId, false),
        () => group(),
      ),
    ).toBeNull();
    expect(
      coordinatedProjectKey(
        thread,
        () => undefined,
        () => group(),
      ),
    ).toBeNull();
    // Scratch and archived projects have no page.
    expect(coordinatedProjectKey(thread, settingsFor, () => group({ isScratch: true }))).toBeNull();
    expect(coordinatedProjectKey(thread, settingsFor, () => group({ archived: true }))).toBeNull();
    expect(coordinatedProjectKey(thread, settingsFor, () => null)).toBeNull();
    // Another machine names a chat too: the page may show that one.
    expect(
      coordinatedProjectKey(
        thread,
        (id) => (id === local ? named(chatId) : named(ThreadId.make("theirs"))),
        () => group(),
      ),
    ).toBeNull();
    // Another machine's settings have not loaded: it may name one.
    expect(
      coordinatedProjectKey(
        thread,
        (id) => (id === local ? named(chatId) : undefined),
        () => group(),
      ),
    ).toBeNull();
  });

  it("sends the coordinator's thread address to its page unless the thread view must show it", () => {
    const settingsFor = (id: string) => (id === local ? named(chatId) : named(null));
    const address = `/${local}/${chatId}`;
    const open = (route: { href: string; heldOffShell?: boolean; background?: boolean }) =>
      threadRouteProjectKey(
        { heldOffShell: false, background: false, ...route },
        thread,
        settingsFor,
        () => group(),
      );
    expect(open({ href: address })).toBe("orchard-key");
    // The page's old Open as thread address.
    expect(open({ href: `${address}?view=thread` })).toBe("orchard-key");
    // A quoted response, which only the thread view reveals.
    const { hash } = assistantCitationRoute(
      {
        version: 1,
        environmentId: local,
        threadId: chatId,
        messageId: MessageId.make("reply"),
        text: "the plan",
        start: 0,
        end: 8,
        prefix: "",
        suffix: "",
      },
      null,
    );
    expect(open({ href: `${address}#${hash}` })).toBeNull();
    expect(open({ href: address, background: true })).toBeNull();
  });

  it("keeps an older settled coordinator in the thread view once its family loads", () => {
    const settingsFor = (id: string) => (id === local ? named(chatId) : named(null));
    const route = (listed: typeof thread | null, heldOffShell: boolean) =>
      threadRouteProjectKey(
        { href: `/${local}/${chatId}`, heldOffShell, background: false },
        listed,
        settingsFor,
        () => group(),
      );
    const key = `${local}:${chatId}`;
    // The shell leaves it out, so the route holds its family in.
    const held = heldOpenThreadKey(key, true, null);
    expect(held).toBe(key);
    expect(route(null, held !== null)).toBeNull();
    // The family brings its row in: no longer missing, still held, still the thread view.
    const stillHeld = heldOpenThreadKey(key, false, held);
    expect(stillHeld).toBe(key);
    expect(route(thread, stillHeld !== null)).toBeNull();
    // Reached while the shell lists it, the same address opens the page.
    expect(route(thread, heldOpenThreadKey(key, false, null) !== null)).toBe("orchard-key");
  });
});
