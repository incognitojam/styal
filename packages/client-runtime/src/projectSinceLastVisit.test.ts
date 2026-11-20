// @effect-diagnostics globalDate:off - fixed instants written as ISO strings, as shells carry them.
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addSinceLastVisitEnvironment,
  captureSinceLastVisit,
  sinceLastVisitGroups,
  sinceLastVisitHistoryGap,
  sinceLastVisitLayout,
  sinceLastVisitMissingBefore,
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

const run = (status: string, completedAt: string | null, startedAt: string | null = null) =>
  ({ status, completedAt, startedAt }) as SinceLastVisitThreadShell["latestRun"];
const byAgent = { latestRunStartedByAgent: true } as SinceLastVisitThreadShell["source"];

const merged = (number: number, mergedAt: string | null) =>
  ({
    host: "github.com",
    repository: "example/harbor",
    number,
    url: `https://github.com/example/harbor/pull/${number}`,
    snapshot: { title: `PR ${number}`, state: mergedAt ? "merged" : "open", mergedAt },
  }) as unknown as SinceLastVisitThreadShell["pullRequests"][number];

const opened = (
  number: number,
  linkedAt: string,
  source = "created",
  repository = "example/harbor",
) =>
  ({
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source,
    linkedAt,
    snapshot: { title: `PR ${number}`, state: "open", mergedAt: null },
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

  it("says when settled threads that could have changed were not on the client", () => {
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
    // Settled before the last visit, but a pull request on one can still merge since.
    expect(add(6, 4)).toBe(open - 6 * HOUR);
    expect(add(2, 0)).toBeNull();
  });

  it("says changes may be missing only when the window reaches back past the threads left out", () => {
    const captured = captureSinceLastVisit(
      { lastVisitedAt: at(5), opens: null, updatedAt: at(1) },
      open,
    )!;
    expect(sinceLastVisitMissingBefore({ ...captured, unloadedBefore: open - 3 * HOUR })).toBe(
      open - 3 * HOUR,
    );
    expect(sinceLastVisitMissingBefore({ ...captured, unloadedBefore: open - 30 * HOUR })).toBe(
      null,
    );
    expect(sinceLastVisitMissingBefore(captured)).toBe(null);
  });

  it("is empty for a chat never visited, such as one created on this page", () => {
    expect(
      captureSinceLastVisit({ lastVisitedAt: null, opens: null, updatedAt: at(0) }, open),
    ).toBeNull();
  });
});

describe("sinceLastVisitThreadLines", () => {
  it("names failures, usage limits, unopened turn ends and merged pull requests, newest first", () => {
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
      ["ended", "fix-upload-test"],
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

  it("says what a turn produced: a pull request it opened, or nothing when its report reaches the chat", () => {
    const lines = sinceLastVisitThreadLines(
      [
        thread("opens-a-pr", {
          latestRun: run("completed", at(2), at(2.5)),
          pullRequests: [opened(230, at(2.1))],
        }),
        // A merge is its own event: the turn that ended after it is still listed.
        thread("merges-a-pr", {
          latestRun: run("completed", at(1.5)),
          pullRequests: [merged(231, at(1))],
        }),
        thread("agent-turn-reports", {
          latestRun: run("completed", at(3)),
          reportTo: { threadId: chat.threadId },
          source: byAgent,
        } as Partial<SinceLastVisitThreadShell>),
        // A turn you started does not report to the chat, so the summary says it ended.
        thread("your-turn-in-a-reporting-thread", {
          latestRun: run("completed", at(3.5)),
          reportTo: { threadId: chat.threadId },
        } as Partial<SinceLastVisitThreadShell>),
        // Linking a pull request that already existed is not opening it.
        thread("links-an-existing-pr", {
          latestRun: run("completed", at(4)),
          pullRequests: [opened(232, at(4.1), "agent")],
        }),
      ],
      chat,
      window.since,
    );
    expect(lines.map((line) => [line.kind, line.title])).toEqual([
      ["merged", "PR 231"],
      ["ended", "merges-a-pr"],
      ["opened", "PR 230"],
      ["ended", "your-turn-in-a-reporting-thread"],
      ["ended", "links-an-existing-pr"],
    ]);
    expect(lines[2]).toMatchObject({ number: 230, threadId: "opens-a-pr" });
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

describe("sinceLastVisitGroups", () => {
  it("shows a report and the pull requests it names as one row, the report's", () => {
    const threadLines = sinceLastVisitThreadLines(
      [
        thread("chip-fix", { pullRequests: [merged(1645, at(1)), merged(1646, at(1.1))] }),
        thread("outline-fix", { pullRequests: [merged(1648, at(0.8))] }),
        thread("hover-cards", {
          latestRun: run("completed", at(2), at(2.5)),
          pullRequests: [opened(1650, at(2.2))],
        }),
        // The same number in two repositories: a report cannot say which, so neither is folded.
        thread("upstream", { pullRequests: [opened(42, at(1), "created", "example/upstream")] }),
        thread("fork", { pullRequests: [opened(42, at(1.5))] }),
      ],
      chat,
      window.since,
    );
    const reportLine = (id: string, key: string, title: string) => ({
      kind: "report" as const,
      id: `report:${id}`,
      messageId: id,
      title,
      reportKey: key,
      version: 1,
      at: open - 1.2 * HOUR,
    });
    const groups = sinceLastVisitGroups(threadLines, [
      reportLine("by-key", "pr:1645", "Report chips while sending: merged, with #1646"),
      reportLine("by-text", "hover-cards", "Hover cards are in review as #1650"),
      reportLine("ambiguous", "release", "Release waits on #42"),
    ]);
    expect(groups.pullRequests.map((line) => line.title)).toEqual(["PR 1648", "PR 42", "PR 42"]);
    expect(
      groups.reports.map((line) =>
        line.kind === "report"
          ? [line.messageId, line.pullRequests?.map((pr) => pr.number)]
          : [line.kind],
      ),
    ).toEqual([
      ["by-key", [1645, 1646]],
      ["by-text", [1650]],
      ["ambiguous", undefined],
    ]);
  });
});

describe("sinceLastVisitLayout", () => {
  const lines = (kind: string, count: number, hoursAgo = 1) =>
    Array.from({ length: count }, (_, index) => ({
      kind,
      title: `${kind} ${index}`,
      at: open - (hoursAgo + index) * HOUR,
    }));
  const summary = (failed: number, reports: number, ended: number, pullRequests: number) => ({
    failed: lines("failed", failed, 3),
    reports: lines("report", reports, 1.5),
    pullRequests: lines("merged", pullRequests, 0.5),
    ended: lines("ended", ended, 2),
  });
  const shape = (layout: ReturnType<typeof sinceLastVisitLayout>) =>
    layout.sections.map((section) => [
      section.group,
      section.display,
      section.lines.length,
      section.hidden,
    ]);

  it("lists up to six changes as one list, newest first", () => {
    const layout = sinceLastVisitLayout(summary(1, 2, 2, 1), new Set());
    expect(layout.total).toBe(6);
    expect(layout.grouped).toBe(false);
    expect(layout.lines.map((line) => line.title)).toEqual([
      "merged 0",
      "report 0",
      "ended 0",
      "report 1",
      "failed 0",
      "ended 1",
    ]);
  });

  it("groups and folds more: every failure, three reports, threads and pull requests as names", () => {
    const layout = sinceLastVisitLayout(summary(2, 14, 23, 9), new Set());
    expect(layout.total).toBe(48);
    expect(layout.grouped).toBe(true);
    expect(shape(layout)).toEqual([
      ["failed", "rows", 2, 0],
      ["reports", "rows", 3, 11],
      ["pullRequests", "names", 4, 5],
      ["ended", "names", 4, 19],
    ]);
    expect(
      shape(sinceLastVisitLayout(summary(2, 14, 23, 9), new Set(["reports", "ended"]))),
    ).toEqual([
      ["failed", "rows", 2, 0],
      ["reports", "rows", 14, 0],
      ["pullRequests", "names", 4, 5],
      ["ended", "rows", 23, 0],
    ]);
  });

  it("is empty when nothing happened", () => {
    const layout = sinceLastVisitLayout(summary(0, 0, 0, 0), new Set());
    expect(layout).toEqual({ total: 0, grouped: false, sections: [], lines: [] });
  });
});
