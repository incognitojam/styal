import {
  type CoordinatorReport,
  type EnvironmentId,
  isListedThreadLineage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell } from "./state/models.ts";

/** The card never reaches further back: a project nobody has caught up on stays bounded. */
export const SINCE_LAST_SEEN_DAYS = 14;
/** Up to this many changes show as one list; more are grouped and folded. */
const SINCE_LAST_VISIT_FLAT_LIMIT = 6;
const FOLDED_REPORTS = 3;
const FOLDED_NAMES = 4;

/** Epoch milliseconds, on the chat server's clock. */
export interface SinceLastVisitWindow {
  readonly since: number;
  /** `since` was held to the last 14 days. */
  readonly capped: boolean;
}

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
 * Where the card starts: when the user last marked the project seen or wrote in its chat, on any
 * device, or when the chat began. Opening the page moves neither. Held to the last 14 days.
 */
export function sinceLastVisitWindow(
  input: {
    readonly seenAt: string | null | undefined;
    readonly chat: Pick<EnvironmentThreadShell, "latestUserAuthoredMessageAt" | "createdAt">;
  },
  now: number,
): SinceLastVisitWindow {
  const marks = [
    parse(input.seenAt),
    parse(input.chat.latestUserAuthoredMessageAt),
    parse(input.chat.createdAt),
  ].filter((mark) => !Number.isNaN(mark));
  const since = marks.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...marks);
  const floor = now - SINCE_LAST_SEEN_DAYS * 24 * 60 * 60 * 1000;
  return since < floor ? { since: floor, capped: true } : { since, capped: false };
}

/**
 * The time "Mark as seen" stores: the newest change the card lists, so anything that arrives
 * afterwards is new. Times stay on the clocks that stamped them.
 */
export function sinceLastVisitSeenAt(
  window: SinceLastVisitWindow,
  lines: ReadonlyArray<{ readonly at: number }>,
): string {
  return DateTime.formatIso(
    DateTime.makeUnsafe(Math.max(window.since, ...lines.map((line) => line.at))),
  );
}

/**
 * Where a machine's shell cut settled threads, when it left out some of the project's: their
 * changes cannot be listed, since a pull request can merge long after its thread settled.
 */
export function sinceLastVisitUnloadedBefore(
  machines: ReadonlyArray<{
    readonly projectIds: ReadonlySet<ProjectId>;
    readonly olderSettled: {
      readonly beforeMs: number;
      readonly counts: ReadonlyMap<ProjectId, number>;
    } | null;
  }>,
): number | null {
  let before: number | null = null;
  for (const { projectIds, olderSettled } of machines) {
    if (olderSettled === null) continue;
    if (![...projectIds].some((projectId) => (olderSettled.counts.get(projectId) ?? 0) > 0))
      continue;
    before = Math.max(before ?? 0, olderSettled.beforeMs);
  }
  return before;
}

/**
 * What changed in the project's threads after `since`, newest first. A shell carries only its
 * latest run: an earlier run that ended in the window and was followed by another is not listed.
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
    if (!tag || !(parse(report.message.createdAt) > window.since)) continue;
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
