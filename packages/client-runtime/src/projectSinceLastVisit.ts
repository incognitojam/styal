import {
  type CoordinatorReport,
  type EnvironmentId,
  isListedThreadLineage,
  type ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

/** Shorter gaps are hops between threads; the timeline already shows what happened. */
const SINCE_LAST_VISIT_MIN_AWAY_MS = 30 * 60 * 1000;
/** Up to this many changes show as one list; more are grouped and folded. */
const SINCE_LAST_VISIT_FLAT_LIMIT = 6;
const FOLDED_REPORTS = 3;
const FOLDED_NAMES = 4;

/** Epoch milliseconds: after `since`, up to and including `until` (when the page opened). */
export interface SinceLastVisitWindow {
  readonly since: number;
  readonly until: number;
}

type MarkerShell = Pick<EnvironmentThreadShell, "lastVisitedAt" | "opens">;

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
>;

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
const within = (at: number, window: SinceLastVisitWindow) =>
  at > window.since && at <= window.until;
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
  return now - since < SINCE_LAST_VISIT_MIN_AWAY_MS ? null : { since, until: now };
}

/** What changed in the project's threads in the window, newest first. */
export function sinceLastVisitThreadLines(
  threads: ReadonlyArray<SinceLastVisitThreadShell>,
  chat: ThreadRef,
  window: SinceLastVisitWindow,
): SinceLastVisitThreadLine[] {
  const lines: SinceLastVisitThreadLine[] = [];
  const pullRequests = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (!isListedThreadLineage(thread.lineage)) continue;
    if (thread.environmentId === chat.environmentId && thread.id === chat.threadId) continue;
    const ref = { environmentId: thread.environmentId, threadId: thread.id };
    const run = thread.latestRun;
    const completedAt = parse(run?.completedAt);
    // Opening the thread after it ended is seeing it.
    const seen = parse(thread.lastVisitedAt) >= completedAt;
    if (run && within(completedAt, window) && !seen) {
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
      if (!within(mergedAt, window) || pullRequests.has(key)) continue;
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
  /** As `coordinatorReports` gives it: replaced, answered, dismissed, open or posted. */
  readonly state: string;
};

/**
 * The chat's reports posted in the window, the latest version per topic, newest first. An open
 * question is in Needs you, and a dismissed report was already seen.
 */
export function sinceLastVisitReportLines(
  reports: ReadonlyArray<ReportState>,
  window: SinceLastVisitWindow,
): SinceLastVisitReportLine[] {
  const latest = new Map<string, ReportState>();
  for (const report of reports) {
    const tag = report.message.report;
    if (!tag || !within(parse(report.message.createdAt), window)) continue;
    if ((latest.get(tag.key)?.message.report?.version ?? 0) < tag.version)
      latest.set(tag.key, report);
  }
  const lines: SinceLastVisitReportLine[] = [];
  for (const { message, state } of latest.values()) {
    if (state === "open" || state === "dismissed" || !message.report) continue;
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
}

/**
 * Taken once per page view, from the first chat shell the page sees: viewing the chat moves its
 * read mark moments later. `undefined` waits for the shell; null is a view with nothing to show.
 */
export function captureSinceLastVisit(
  previous: CapturedSinceLastVisit | null | undefined,
  input: {
    readonly chat: MarkerShell | null;
    readonly chatRef: ThreadRef;
    readonly threads: ReadonlyArray<SinceLastVisitThreadShell>;
  },
  now: number,
): CapturedSinceLastVisit | null | undefined {
  if (previous !== undefined) return previous;
  if (input.chat === null) return undefined;
  const window = sinceLastVisitWindow(input.chat, now);
  if (window === null) return null;
  return { window, threadLines: sinceLastVisitThreadLines(input.threads, input.chatRef, window) };
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
