// @effect-diagnostics globalDate:off - fixed instants written as ISO strings, as shells carry them.
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addSinceLastVisitEnvironment,
  captureSinceLastVisit,
  sinceLastVisitHistoryGap,
  sinceLastVisitLayout,
  sinceLastVisitReportLines,
  sinceLastVisitReportsKey,
  sinceLastVisitThreadLines,
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
// The chat last changed an hour before the page opened.
const window = { since: open - 5 * HOUR, until: open, reportsUntil: open - HOUR };

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
  it("starts at the later of the chat's read mark and its last open, shared by every client", () => {
    expect(
      sinceLastVisitWindow({ lastVisitedAt: at(5), opens: null, updatedAt: at(1) }, open),
    ).toEqual(window);
    // The chat did not change while the user looked an hour ago: the open is later than the read mark.
    expect(
      sinceLastVisitWindow(
        {
          lastVisitedAt: at(30),
          opens: { openedAt: open - 1 * HOUR, score: 1, picks: [] },
          updatedAt: at(30),
        },
        open,
      ),
    ).toEqual({ since: open - HOUR, until: open, reportsUntil: open - HOUR });
  });

  it("is empty for a chat never visited, and under 30 minutes away", () => {
    const updatedAt = at(1);
    expect(sinceLastVisitWindow({ lastVisitedAt: null, opens: null, updatedAt }, open)).toBeNull();
    // A server that predates read marks sends neither.
    expect(sinceLastVisitWindow({ updatedAt }, open)).toBeNull();
    expect(
      sinceLastVisitWindow({ lastVisitedAt: at(29 / 60), opens: null, updatedAt }, open),
    ).toBeNull();
    expect(
      sinceLastVisitWindow({ lastVisitedAt: at(30 / 60), opens: null, updatedAt }, open),
    ).not.toBeNull();
  });
});

describe("captureSinceLastVisit", () => {
  const harbor = new Set([project]);

  it("adds each machine once, when its snapshot is live, so later shells leave it unchanged", () => {
    const remote = EnvironmentId.make("env-remote");
    const captured = captureSinceLastVisit(
      { lastVisitedAt: at(5), opens: null, updatedAt: at(1) },
      open,
    )!;
    expect(captured.window).toEqual(window);
    const local = addSinceLastVisitEnvironment(captured, {
      environmentId: env,
      projectIds: harbor,
      threads: [
        thread("fix-upload-test", { latestRun: run("completed", at(2)) }),
        thread("on-remote", { environmentId: remote, latestRun: run("completed", at(3)) }),
        thread("other-project", {
          projectId: ProjectId.make("project-other"),
          latestRun: run("completed", at(3)),
        }),
      ],
      chatRef: chat,
      olderSettled: null,
    });
    expect(local.threadLines.map((line) => line.title)).toEqual(["fix-upload-test"]);
    // Opening the thread later in this view must not take it off the card.
    expect(
      addSinceLastVisitEnvironment(local, {
        environmentId: env,
        projectIds: harbor,
        threads: [],
        chatRef: chat,
        olderSettled: null,
      }),
    ).toBe(local);
    const both = addSinceLastVisitEnvironment(
      addSinceLastVisitEnvironment(captured, {
        environmentId: env,
        projectIds: harbor,
        threads: [
          thread("fix-upload-test", {
            latestRun: run("completed", at(2)),
            pullRequests: [merged(230, at(0.5))],
          }),
        ],
        chatRef: chat,
        olderSettled: null,
      }),
      {
        environmentId: remote,
        projectIds: harbor,
        threads: [
          thread("on-remote", {
            environmentId: remote,
            latestRun: run("failed", at(1)),
            pullRequests: [merged(230, at(0.5))],
          }),
        ],
        chatRef: chat,
        olderSettled: null,
      },
    );
    expect(both.threadLines.map((line) => line.title)).toEqual([
      "PR 230",
      "on-remote",
      "fix-upload-test",
    ]);
    expect([...both.environments]).toEqual([env, remote]);
  });

  it("says when threads that settled since the last visit were not on the client", () => {
    const captured = captureSinceLastVisit(
      { lastVisitedAt: at(5), opens: null, updatedAt: at(1) },
      open,
    )!;
    const add = (beforeHoursAgo: number, count: number) =>
      addSinceLastVisitEnvironment(captured, {
        environmentId: env,
        projectIds: harbor,
        threads: [],
        chatRef: chat,
        olderSettled: {
          beforeMs: open - beforeHoursAgo * HOUR,
          counts: new Map([[project, count]]),
        },
      }).unloadedBefore;
    expect(add(2, 4)).toBe(open - 2 * HOUR);
    // The cut is before the last visit, so every thread that settled since was loaded.
    expect(add(6, 4)).toBeNull();
    expect(add(2, 0)).toBeNull();
  });

  it("is empty for a chat never visited, such as one created on this page", () => {
    expect(
      captureSinceLastVisit({ lastVisitedAt: null, opens: null, updatedAt: at(0) }, open),
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

  it("lists a pull request linked to several threads once", () => {
    const lines = sinceLastVisitThreadLines(
      [
        thread("author", { pullRequests: [merged(214, at(1))] }),
        thread("reviewer", { pullRequests: [merged(214, at(1))] }),
      ],
      chat,
      window.since,
    );
    expect(lines.map((line) => line.title)).toEqual(["PR 214"]);
  });
});

describe("sinceLastVisitReportsKey", () => {
  it("changes when a report is resolved in place", () => {
    const report = { id: "r", report: { version: 1 } };
    const resolved = {
      ...report,
      report: { version: 1, resolved: { at: "2026-11-19T00:00:00Z" } },
    };
    expect(sinceLastVisitReportsKey(null, [report], [])).not.toBe(
      sinceLastVisitReportsKey(null, [resolved], []),
    );
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
        // A later version posted after the page opened replaced it; it still happened in the window.
        report("r4", "telemetry", 1, at(4), "replaced"),
        report("r5", "telemetry", 2, at(-0.5), "open"),
        report("r6", "release", 1, at(2), "open"),
        report("r7", "fuzz", 1, at(2), "dismissed"),
        // Dismissed, then replaced by a version posted after the page opened.
        report("r8", "docs", 1, at(3), "replaced"),
        report("r9", "docs", 2, at(0.5), "open"),
        // Posted after the chat's last change before the page opened.
        report("r10", "late", 1, at(0.5), "posted"),
      ],
      [{ messageId: "r8", version: 1 }],
      window,
    );
    expect(lines.map((line) => [line.messageId, line.version])).toEqual([
      ["r3", 1],
      ["r2", 3],
      ["r4", 1],
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
