import {
  type CoordinatorReport,
  type EnvironmentId,
  isListedThreadLineage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

/** Shorter gaps are hops between threads; the timeline already shows what happened. */
const SINCE_LAST_VISIT_MIN_AWAY_MS = 30 * 60 * 1000;
/** Up to this many changes show as one list; more are grouped and folded. */
const SINCE_LAST_VISIT_FLAT_LIMIT = 6;
const FOLDED_REPORTS = 3;
const FOLDED_NAMES = 4;

/** Epoch milliseconds. */
export interface SinceLastVisitWindow {
  /** The user's last visit, on the chat server's clock. */
  readonly since: number;
  /** When the page opened, on this client's clock: for the 30-minute gap and time labels only. */
  readonly until: number;
  /** The chat's last change when the page opened, on its server's clock: later reports are new. */
  readonly reportsUntil: number;
}

type MarkerShell = Pick<EnvironmentThreadShell, "lastVisitedAt" | "opens" | "updatedAt">;

export type SinceLastVisitThreadShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "latestRun"
  | "runtime"
  | "lastVisitedAt"
  | "pullRequests"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "openReportQuestionCount"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
>;

/**
 * Waiting on an approval, a question or a guest's message: the page's Needs you or the chat's
 * started-threads list shows it instead.
 */
const needsYou = (thread: SinceLastVisitThreadShell) =>
  thread.hasPendingApprovals ||
  thread.hasPendingUserInput ||
  (thread.openReportQuestionCount ?? 0) > 0 ||
  thread.pendingSubagentRequest != null ||
  (thread.pendingGuestMessageCount ?? 0) > 0;

interface ThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

interface LineBase extends ThreadRef {
  /** Unique within the summary. */
  readonly id: string;
  readonly title: string;
  readonly at: number;
}

export type SinceLastVisitThreadLine =
  | (LineBase & { readonly kind: "failed"; readonly error: string | null })
  | (LineBase & { readonly kind: "limited"; readonly resetAt: string | null })
  | (LineBase & { readonly kind: "finished" })
  | (LineBase & { readonly kind: "merged"; readonly number: number; readonly url: string });

export interface SinceLastVisitReportLine {
  readonly kind: "report";
  readonly id: string;
  readonly messageId: string;
  readonly title: string;
  readonly reportKey: string;
  readonly version: number;
  readonly at: number;
}

export type SinceLastVisitLine = SinceLastVisitThreadLine | SinceLastVisitReportLine;

const parse = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const newestFirst = (a: { readonly at: number }, b: { readonly at: number }) => b.at - a.at;

/**
 * When the user last saw the project chat, from any of their clients: the later of the chat's
 * read mark (the server's `lastVisitedAt`) and its last open, which covers a chat that did not
 * change while they looked. Null when the chat was never visited or the gap is under 30 minutes.
 */
export function sinceLastVisitWindow(chat: MarkerShell, now: number): SinceLastVisitWindow | null {
  const marks = [parse(chat.lastVisitedAt), chat.opens?.openedAt ?? Number.NaN].filter(
    (mark) => !Number.isNaN(mark),
  );
  if (marks.length === 0) return null;
  const since = Math.max(...marks);
  if (now - since < SINCE_LAST_VISIT_MIN_AWAY_MS) return null;
  return { since, until: now, reportsUntil: Math.max(since, parse(chat.updatedAt)) };
}

/**
 * What changed in the project's threads after `since`, newest first. The threads are a snapshot
 * taken when the page opened, so nothing later is in it. A shell carries only its latest run: an
 * earlier run that ended in the window and was followed by another is not listed.
 */
export function sinceLastVisitThreadLines(
  threads: ReadonlyArray<SinceLastVisitThreadShell>,
  chat: ThreadRef,
  since: number,
): SinceLastVisitThreadLine[] {
  const lines: SinceLastVisitThreadLine[] = [];
  const pullRequests = new Set<string>();
  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;
    if (!isListedThreadLineage(thread.lineage)) continue;
    if (thread.environmentId === chat.environmentId && thread.id === chat.threadId) continue;
    const ref = { environmentId: thread.environmentId, threadId: thread.id };
    const run = thread.latestRun;
    const completedAt = parse(run?.completedAt);
    // Opening the thread after it ended is seeing it; archiving it is putting it away.
    const seen = parse(thread.lastVisitedAt) >= completedAt || thread.archivedAt !== null;
    if (run && completedAt > since && !seen && !needsYou(thread)) {
      const base = { ...ref, id: `thread:${thread.environmentId}:${thread.id}` };
      const line = { ...base, title: thread.title, at: completedAt };
      if (run.status === "failed") {
        lines.push(
          thread.runtime?.lastErrorClass === "usage_limit"
            ? { ...line, kind: "limited", resetAt: thread.runtime.usageLimitResetAt ?? null }
            : {
                ...line,
                kind: "failed",
                error: thread.runtime?.lastError?.trim().split("\n")[0]?.trim() || null,
              },
        );
      } else if (run.status === "completed") {
        lines.push({ ...line, kind: "finished" });
      }
    }
    for (const pullRequest of thread.pullRequests) {
      const mergedAt = parse(pullRequest.snapshot?.mergedAt);
      const key = `${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`;
      if (!(mergedAt > since) || pullRequests.has(key)) continue;
      pullRequests.add(key);
      lines.push({
        ...ref,
        kind: "merged",
        id: `pr:${key}`,
        title: pullRequest.snapshot?.title ?? `#${pullRequest.number}`,
        at: mergedAt,
        number: pullRequest.number,
        url: pullRequest.url,
      });
    }
  }
  return lines.sort(newestFirst);
}

type ReportState = {
  readonly message: {
    readonly id: string;
    readonly createdAt: string;
    readonly report?: Pick<CoordinatorReport, "key" | "title" | "version"> | undefined;
  };
  /** As `coordinatorReports` gives it: replaced, resolved, answered, dismissed, open or posted. */
  readonly state: string;
};

/**
 * The chat's reports posted in the window, the latest version per topic, newest first. An open
 * question is in Needs you, and a dismissed report was already seen, even once a newer version
 * replaced it.
 */
export function sinceLastVisitReportLines(
  reports: ReadonlyArray<ReportState>,
  dismissals: ReadonlyArray<{ readonly messageId: string; readonly version: number }>,
  window: SinceLastVisitWindow,
): SinceLastVisitReportLine[] {
  const latest = new Map<string, ReportState>();
  for (const report of reports) {
    const tag = report.message.report;
    const at = parse(report.message.createdAt);
    if (!tag || !(at > window.since && at <= window.reportsUntil)) continue;
    if ((latest.get(tag.key)?.message.report?.version ?? 0) < tag.version)
      latest.set(tag.key, report);
  }
  const dismissed = new Set(dismissals.map((ref) => `${ref.messageId}\0${ref.version}`));
  const lines: SinceLastVisitReportLine[] = [];
  for (const { message, state } of latest.values()) {
    if (state === "open" || state === "dismissed" || !message.report) continue;
    if (dismissed.has(`${message.id}\0${message.report.version}`)) continue;
    lines.push({
      kind: "report",
      id: `report:${message.id}`,
      messageId: message.id,
      title: message.report.title,
      reportKey: message.report.key,
      version: message.report.version,
      at: parse(message.createdAt),
    });
  }
  return lines.sort(newestFirst);
}

/**
 * Changes when anything the card reads from the chat's reports changes. A resolve updates its
 * report message in place, so the key includes it.
 */
export function sinceLastVisitReportsKey(
  earliestLoadedAt: string | null,
  messages: ReadonlyArray<{
    readonly id: string;
    readonly report?: Pick<CoordinatorReport, "version" | "resolved"> | undefined;
    readonly reportAnswer?: { readonly messageId: string; readonly version: number } | undefined;
  }>,
  dismissals: ReadonlyArray<{ readonly messageId: string; readonly version: number }>,
): string {
  return JSON.stringify([
    earliestLoadedAt,
    messages.map((m) => [
      m.id,
      m.report?.version,
      m.report?.resolved?.at,
      m.reportAnswer?.messageId,
      m.reportAnswer?.version,
    ]),
    dismissals.map((d) => [d.messageId, d.version]),
  ]);
}

/**
 * Reports come from the chat's loaded history. When older history is still unloaded and the
 * loaded part starts after `since`, some reports in the window may be missing.
 */
export function sinceLastVisitHistoryGap(
  history: { readonly hasMoreHistory: boolean; readonly earliestLoadedAt: string | null },
  window: SinceLastVisitWindow,
): { readonly loadedFrom: number | null } | null {
  if (!history.hasMoreHistory) return null;
  const loadedFrom = parse(history.earliestLoadedAt);
  if (Number.isNaN(loadedFrom)) return { loadedFrom: null };
  return loadedFrom > window.since ? { loadedFrom } : null;
}

export interface CapturedSinceLastVisit {
  readonly window: SinceLastVisitWindow;
  readonly threadLines: ReadonlyArray<SinceLastVisitThreadLine>;
  /** The machines whose threads are in `threadLines`, each read once its snapshot was live. */
  readonly environments: ReadonlySet<EnvironmentId>;
  /**
   * Threads that settled after the last visit but before this time were not on the client, so
   * they are not listed. Null when every thread settled since the last visit was there.
   */
  readonly unloadedBefore: number | null;
}

/**
 * Taken once per page view from the chat's live shell, before the page records the visit. Null
 * when the chat was never visited or the user was away under 30 minutes.
 */
export function captureSinceLastVisit(
  chat: MarkerShell,
  now: number,
): CapturedSinceLastVisit | null {
  const window = sinceLastVisitWindow(chat, now);
  return window === null
    ? null
    : { window, threadLines: [], environments: new Set(), unloadedBefore: null };
}

/**
 * Adds one machine's threads, read once from its live snapshot; a machine already added is kept as
 * it was. `olderSettled` is where that machine's shell cut settled threads, with how many it left
 * out per project.
 */
export function addSinceLastVisitEnvironment(
  captured: CapturedSinceLastVisit,
  input: {
    readonly environmentId: EnvironmentId;
    readonly projectIds: ReadonlySet<ProjectId>;
    readonly threads: ReadonlyArray<SinceLastVisitThreadShell>;
    readonly chatRef: ThreadRef;
    readonly olderSettled: {
      readonly beforeMs: number;
      readonly counts: ReadonlyMap<ProjectId, number>;
    } | null;
  },
): CapturedSinceLastVisit {
  if (captured.environments.has(input.environmentId)) return captured;
  const threads = input.threads.filter(
    (thread) =>
      thread.environmentId === input.environmentId && input.projectIds.has(thread.projectId),
  );
  const older = input.olderSettled;
  const leftOut =
    older !== null &&
    older.beforeMs > captured.window.since &&
    [...input.projectIds].some((projectId) => (older.counts.get(projectId) ?? 0) > 0);
  // A pull request linked to threads on two machines is one line.
  const listed = new Set(captured.threadLines.map((line) => line.id));
  return {
    ...captured,
    threadLines: [
      ...captured.threadLines,
      ...sinceLastVisitThreadLines(threads, input.chatRef, captured.window.since).filter(
        (line) => !listed.has(line.id),
      ),
    ].sort(newestFirst),
    environments: new Set(captured.environments).add(input.environmentId),
    unloadedBefore: leftOut
      ? Math.max(captured.unloadedBefore ?? 0, older.beforeMs)
      : captured.unloadedBefore,
  };
}

export type SinceLastVisitGroup = "failed" | "reports" | "finished" | "merged";

export interface SinceLastVisitSection<Line> {
  readonly group: SinceLastVisitGroup;
  /** One row per line, or the lines' names joined on one row. */
  readonly display: "rows" | "names";
  readonly lines: ReadonlyArray<Line>;
  readonly total: number;
  readonly hidden: number;
}

/**
 * Up to six changes are one list. More are grouped: every failure, the three newest reports, and
 * finished threads and merged pull requests as one row of names, each until expanded.
 */
export function sinceLastVisitLayout<Line>(
  groups: Readonly<Record<SinceLastVisitGroup, ReadonlyArray<Line>>>,
  expanded: ReadonlySet<SinceLastVisitGroup>,
): {
  readonly total: number;
  readonly grouped: boolean;
  readonly sections: ReadonlyArray<SinceLastVisitSection<Line>>;
} {
  const order = ["failed", "reports", "finished", "merged"] as const;
  const total = order.reduce((sum, group) => sum + groups[group].length, 0);
  const grouped = total > SINCE_LAST_VISIT_FLAT_LIMIT;
  const sections = order.flatMap((group): SinceLastVisitSection<Line>[] => {
    const lines = groups[group];
    if (lines.length === 0) return [];
    const folded = grouped && group !== "failed" && !expanded.has(group);
    const shown = folded ? (group === "reports" ? FOLDED_REPORTS : FOLDED_NAMES) : lines.length;
    return [
      {
        group,
        display: folded && group !== "reports" ? "names" : "rows",
        lines: lines.slice(0, shown),
        total: lines.length,
        hidden: Math.max(0, lines.length - shown),
      },
    ];
  });
  return { total, grouped, sections };
}

/** Splits the window's lines into the card's groups. */
export function sinceLastVisitGroups(
  threadLines: ReadonlyArray<SinceLastVisitThreadLine>,
  reportLines: ReadonlyArray<SinceLastVisitReportLine>,
): Record<SinceLastVisitGroup, ReadonlyArray<SinceLastVisitLine>> {
  return {
    failed: threadLines.filter((line) => line.kind === "failed" || line.kind === "limited"),
    reports: reportLines,
    finished: threadLines.filter((line) => line.kind === "finished"),
    merged: threadLines.filter((line) => line.kind === "merged"),
  };
}
