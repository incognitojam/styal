// @effect-diagnostics globalDate:off - fixed instants written as ISO strings, as shells carry them.
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { projectCoordinatorPatch, projectSeenPatch } from "./state/projectCoordinators.ts";
import {
  SINCE_LAST_SEEN_DAYS,
  sinceLastVisitHistoryGap,
  sinceLastVisitLayout,
  sinceLastVisitReportLines,
  sinceLastVisitSeenAt,
  sinceLastVisitThreadLines,
  sinceLastVisitUnloadedBefore,
  sinceLastVisitWindow,
  type SinceLastVisitThreadShell,
} from "./projectSinceLastVisit.ts";

const HOUR = 3_600_000;
const env = EnvironmentId.make("env-local");
const project = ProjectId.make("project-harbor");
const chat = { environmentId: env, threadId: ThreadId.make("thread-chat") };
// The page opened at `open`; the user last looked five hours before.
const open = Date.parse("2026-11-18T18:00:00.000Z");
const at = (hoursBeforeOpen: number) => new Date(open - hoursBeforeOpen * HOUR).toISOString();
// The user last marked the project seen five hours before.
const window = { since: open - 5 * HOUR, capped: false };

function thread(
  id: string,
  overrides: Partial<SinceLastVisitThreadShell> = {},
): SinceLastVisitThreadShell {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    projectId: project,
    title: id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    archivedAt: null,
    deletedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestRun: null,
    runtime: null,
    lastVisitedAt: null,
    pullRequests: [],
    ...overrides,
  } as SinceLastVisitThreadShell;
}

const run = (status: string, completedAt: string | null) =>
  ({ status, completedAt }) as SinceLastVisitThreadShell["latestRun"];

const merged = (number: number, mergedAt: string | null) =>
  ({
    host: "github.com",
    repository: "example/harbor",
    number,
    url: `https://github.com/example/harbor/pull/${number}`,
    snapshot: { title: `PR ${number}`, state: mergedAt ? "merged" : "open", mergedAt },
  }) as unknown as SinceLastVisitThreadShell["pullRequests"][number];

const report = (id: string, key: string, version: number, createdAt: string, state: string) => ({
  message: { id, createdAt, report: { key, title: `${key} v${version}`, version } },
  state: state as "posted",
});

describe("sinceLastVisitWindow", () => {
  const chatShell = { createdAt: at(30), latestUserAuthoredMessageAt: at(6) };

  it("starts at the later of Mark as seen and the user's last message in the chat", () => {
    expect(sinceLastVisitWindow({ seenAt: at(5), chat: chatShell }, open)).toEqual(window);
    // Writing in the chat moves it too.
    expect(
      sinceLastVisitWindow(
        { seenAt: at(5), chat: { ...chatShell, latestUserAuthoredMessageAt: at(2) } },
        open,
      ),
    ).toEqual({ since: open - 2 * HOUR, capped: false });
    // Never marked and never written in: from when the chat began.
    expect(
      sinceLastVisitWindow(
        { seenAt: undefined, chat: { createdAt: at(8), latestUserAuthoredMessageAt: null } },
        open,
      ),
    ).toEqual({ since: open - 8 * HOUR, capped: false });
  });

  it("does not move when the page is opened", () => {
    // Opening records a visit on the chat thread, which the window does not read.
    const opened = { ...chatShell, lastVisitedAt: at(0), opens: { openedAt: open } };
    expect(sinceLastVisitWindow({ seenAt: at(5), chat: opened }, open)).toEqual(window);
  });

  it("reaches back at most 14 days", () => {
    expect(
      sinceLastVisitWindow(
        {
          seenAt: at(24 * 30),
          chat: { createdAt: at(24 * 40), latestUserAuthoredMessageAt: null },
        },
        open,
      ),
    ).toEqual({ since: open - SINCE_LAST_SEEN_DAYS * 24 * HOUR, capped: true });
  });

  it("is shown on another client until the mark moves, and empty there afterwards", () => {
    const threads = [thread("fix-upload-test", { latestRun: run("completed", at(2)) })];
    const settings = applyServerSettingsPatch(
      applyServerSettingsPatch(
        { ...DEFAULT_SERVER_SETTINGS, projectCoordinatorsEnabled: true },
        projectCoordinatorPatch(project, chat.threadId),
      ),
      projectSeenPatch(project, chat.threadId, at(5)),
    );
    const linesOn = (current: typeof settings) =>
      sinceLastVisitThreadLines(
        threads,
        chat,
        sinceLastVisitWindow(
          { seenAt: current.projectCoordinators[project]?.seenAt, chat: chatShell },
          open,
        ).since,
      );
    expect(linesOn(settings).map((line) => line.title)).toEqual(["fix-upload-test"]);
    // Mark as seen on one device stores the newest listed change; every client reads the setting.
    const seenAt = sinceLastVisitSeenAt(window, linesOn(settings));
    expect(seenAt).toBe(at(2));
    const marked = applyServerSettingsPatch(
      settings,
      projectSeenPatch(project, chat.threadId, seenAt),
    );
    expect(marked.projectCoordinators[project]?.threadId).toBe(chat.threadId);
    expect(linesOn(marked)).toEqual([]);
  });
});

describe("sinceLastVisitUnloadedBefore", () => {
  it("says when a machine left out settled threads of the project, whose changes cannot be listed", () => {
    const harbor = new Set([project]);
    const older = (beforeHoursAgo: number, count: number) => ({
      projectIds: harbor,
      olderSettled: { beforeMs: open - beforeHoursAgo * HOUR, counts: new Map([[project, count]]) },
    });
    expect(sinceLastVisitUnloadedBefore([older(6, 4), older(2, 1)])).toBe(open - 2 * HOUR);
    expect(
      sinceLastVisitUnloadedBefore([older(2, 0), { projectIds: harbor, olderSettled: null }]),
    ).toBeNull();
  });
});

describe("sinceLastVisitThreadLines", () => {
  it("names failures, usage limits, unopened finished threads and merged pull requests, newest first", () => {
    const lines = sinceLastVisitThreadLines(
      [
        thread("arm-benchmark", {
          latestRun: run("failed", at(2)),
          runtime: { lastError: "Runner went offline\nstack…", lastErrorClass: "provider_error" },
        } as Partial<SinceLastVisitThreadShell>),
        thread("fuzz-pass", {
          latestRun: run("failed", at(1)),
          runtime: { lastError: "Limit", lastErrorClass: "usage_limit", usageLimitResetAt: at(-2) },
        } as Partial<SinceLastVisitThreadShell>),
        thread("fix-upload-test", { latestRun: run("completed", at(4)) }),
        thread("toml-config", { pullRequests: [merged(212, at(0.5))] }),
      ],
      chat,
      window.since,
    );
    expect(lines.map((line) => [line.kind, line.title])).toEqual([
      ["merged", "PR 212"],
      ["limited", "fuzz-pass"],
      ["failed", "arm-benchmark"],
      ["finished", "fix-upload-test"],
    ]);
    expect(lines[0]).toMatchObject({ number: 212, threadId: "toml-config" });
    expect(lines[1]).toMatchObject({ resetAt: at(-2) });
    expect(lines[2]).toMatchObject({ error: "Runner went offline" });
  });

  it("leaves out what happened outside the window, what was already opened, and threads that do not list", () => {
    const lines = sinceLastVisitThreadLines(
      [
        thread("before", { latestRun: run("completed", at(6)) }),
        thread("still-working", { latestRun: run("running", null) }),
        thread("stopped", { latestRun: run("interrupted", at(1)) }),
        thread("opened-since", { latestRun: run("completed", at(3)), lastVisitedAt: at(2) }),
        thread("failure-seen", { latestRun: run("failed", at(3)), lastVisitedAt: at(3) }),
        thread("archived", { latestRun: run("completed", at(3)), archivedAt: at(1) }),
        thread("deleted-pr", { pullRequests: [merged(150, at(1))], deletedAt: at(0.5) }),
        thread("deleted", { latestRun: run("completed", at(3)), deletedAt: at(1) }),
        thread("subagent", {
          latestRun: run("completed", at(3)),
          lineage: {
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("parent"),
          },
        } as Partial<SinceLastVisitThreadShell>),
        thread("thread-chat", { latestRun: run("completed", at(1)) }),
        // Needs you lists these.
        thread("asks-a-question", {
          latestRun: run("completed", at(2)),
          openReportQuestionCount: 1,
        }),
        thread("awaits-approval", { latestRun: run("failed", at(2)), hasPendingApprovals: true }),
        thread("guest-waiting", {
          latestRun: run("completed", at(2)),
          pendingGuestMessageCount: 1,
        }),
        thread("subagent-asks", {
          latestRun: run("completed", at(2)),
          pendingSubagentRequest: "user_input",
        } as Partial<SinceLastVisitThreadShell>),
        thread("old-pr", { pullRequests: [merged(100, at(7)), merged(101, null)] }),
      ],
      chat,
      window.since,
    );
    expect(lines).toEqual([]);
  });

  it("lists a pull request that merged on a thread archived since", () => {
    const lines = sinceLastVisitThreadLines(
      [thread("archived", { archivedAt: at(0.5), pullRequests: [merged(220, at(1))] })],
      chat,
      window.since,
    );
    expect(lines.map((line) => line.title)).toEqual(["PR 220"]);
  });

  it("lists a pull request linked to several threads once, on any machine", () => {
    const lines = sinceLastVisitThreadLines(
      [
        thread("author", { pullRequests: [merged(214, at(1))] }),
        thread("reviewer", {
          environmentId: EnvironmentId.make("env-remote"),
          pullRequests: [merged(214, at(1))],
        }),
      ],
      chat,
      window.since,
    );
    expect(lines.map((line) => line.title)).toEqual(["PR 214"]);
  });
});

describe("sinceLastVisitReportLines", () => {
  it("keeps the latest version posted in the window per topic, and leaves open and dismissed reports out", () => {
    const lines = sinceLastVisitReportLines(
      [
        report("r0", "backoff", 1, at(6), "replaced"),
        report("r1", "backoff", 2, at(3), "replaced"),
        report("r2", "backoff", 3, at(2), "answered"),
        report("r3", "toml", 1, at(1), "posted"),
        // The newest version asks a question, which Needs you shows, so the topic is left out.
        report("r4", "telemetry", 1, at(4), "replaced"),
        report("r5", "telemetry", 2, at(-0.5), "open"),
        report("r6", "release", 1, at(2), "open"),
        report("r7", "fuzz", 1, at(2), "dismissed"),
        report("r10", "late", 1, at(0.5), "posted"),
      ],
      window,
    );
    expect(lines.map((line) => [line.messageId, line.version])).toEqual([
      ["r10", 1],
      ["r3", 1],
      ["r2", 3],
    ]);
  });
});

describe("sinceLastVisitHistoryGap", () => {
  it("says how far loaded history reaches when earlier history could hold reports from the window", () => {
    expect(
      sinceLastVisitHistoryGap({ hasMoreHistory: true, earliestLoadedAt: at(2) }, window),
    ).toEqual({ loadedFrom: open - 2 * HOUR });
    expect(
      sinceLastVisitHistoryGap({ hasMoreHistory: true, earliestLoadedAt: null }, window),
    ).toEqual({ loadedFrom: null });
    expect(
      sinceLastVisitHistoryGap({ hasMoreHistory: true, earliestLoadedAt: at(6) }, window),
    ).toBeNull();
    expect(
      sinceLastVisitHistoryGap({ hasMoreHistory: false, earliestLoadedAt: at(1) }, window),
    ).toBeNull();
  });
});

describe("sinceLastVisitLayout", () => {
  const lines = (kind: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({ kind, title: `${kind} ${index}` }));
  const summary = (failed: number, reports: number, finished: number, merged: number) => ({
    failed: lines("failed", failed),
    reports: lines("report", reports),
    finished: lines("finished", finished),
    merged: lines("merged", merged),
  });
  const shape = (layout: ReturnType<typeof sinceLastVisitLayout>) =>
    layout.sections.map((section) => [
      section.group,
      section.display,
      section.lines.length,
      section.hidden,
    ]);

  it("lists up to six changes as one ungrouped list, failures first", () => {
    const layout = sinceLastVisitLayout(summary(1, 2, 2, 1), new Set());
    expect(layout.total).toBe(6);
    expect(layout.grouped).toBe(false);
    expect(shape(layout)).toEqual([
      ["failed", "rows", 1, 0],
      ["reports", "rows", 2, 0],
      ["finished", "rows", 2, 0],
      ["merged", "rows", 1, 0],
    ]);
  });

  it("groups and folds more: every failure, three reports, threads and pull requests as names", () => {
    const layout = sinceLastVisitLayout(summary(2, 14, 23, 9), new Set());
    expect(layout.total).toBe(48);
    expect(layout.grouped).toBe(true);
    expect(shape(layout)).toEqual([
      ["failed", "rows", 2, 0],
      ["reports", "rows", 3, 11],
      ["finished", "names", 4, 19],
      ["merged", "names", 4, 5],
    ]);
    expect(
      shape(sinceLastVisitLayout(summary(2, 14, 23, 9), new Set(["reports", "finished"]))),
    ).toEqual([
      ["failed", "rows", 2, 0],
      ["reports", "rows", 14, 0],
      ["finished", "rows", 23, 0],
      ["merged", "names", 4, 5],
    ]);
  });

  it("is empty when nothing happened", () => {
    const layout = sinceLastVisitLayout(summary(0, 0, 0, 0), new Set());
    expect(layout).toEqual({ total: 0, grouped: false, sections: [] });
  });
});
