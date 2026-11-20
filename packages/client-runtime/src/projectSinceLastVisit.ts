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
  | "reportTo"
  | "source"
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

type PullRequestLine = LineBase & {
  readonly kind: "merged" | "opened";
  readonly number: number;
  readonly url: string;
};

export type SinceLastVisitThreadLine =
  | (LineBase & { readonly kind: "failed"; readonly error: string | null })
  | (LineBase & { readonly kind: "limited"; readonly resetAt: string | null })
  /** A turn ended without a pull request, in a thread whose results do not reach the chat. */
  | (LineBase & { readonly kind: "ended" })
  | PullRequestLine;

export interface SinceLastVisitReportLine {
  readonly kind: "report";
  readonly id: string;
  readonly messageId: string;
  readonly title: string;
  readonly reportKey: string;
  readonly version: number;
  readonly at: number;
  /** The pull requests the report is about, when the summary would otherwise list them too. */
  readonly pullRequests?: ReadonlyArray<{
    readonly number: number;
    readonly state: "merged" | "opened";
    readonly url: string;
  }>;
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
 * What changed in the project's threads after `since`, newest first; a shell carries only its
 * latest run. A turn that opened a pull request is that pull request's line, and a turn an agent
 * started in a thread that reports to the chat is left to the report the chat receives.
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
    let openedInRun = false;
    for (const pullRequest of thread.pullRequests) {
      const mergedAt = parse(pullRequest.snapshot?.mergedAt);
      // Linking a pull request that already existed is not opening it.
      const openedAt = pullRequest.source === "created" ? parse(pullRequest.linkedAt) : Number.NaN;
      const kind =
        mergedAt > since
          ? "merged"
          : pullRequest.snapshot?.state === "open" && openedAt > since
            ? "opened"
            : null;
      if (kind === null) continue;
      if (
        kind === "opened" &&
        openedAt >= parse(run?.startedAt ?? run?.completedAt) &&
        openedAt <= completedAt
      )
        openedInRun = true;
      const key = `${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`;
      if (pullRequests.has(key)) continue;
      pullRequests.add(key);
      lines.push({
        ...ref,
        kind,
        id: `pr:${key}`,
        title: pullRequest.snapshot?.title ?? `#${pullRequest.number}`,
        at: kind === "merged" ? mergedAt : openedAt,
        number: pullRequest.number,
        url: pullRequest.url,
      });
    }
    // Opening the thread after it ended is seeing it; archiving it is putting it away.
    const seen = parse(thread.lastVisitedAt) >= completedAt || thread.archivedAt !== null;
    if (!run || !(completedAt > since) || seen || needsYou(thread)) continue;
    const line = {
      ...ref,
      id: `thread:${thread.environmentId}:${thread.id}`,
      title: thread.title,
      at: completedAt,
    };
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
    } else if (
      run.status === "completed" &&
      !openedInRun &&
      // The server reports an agent's turn to the chat; a turn you started is not reported.
      !(
        thread.source?.latestRunStartedByAgent === true &&
        thread.environmentId === chat.environmentId &&
        thread.reportTo?.threadId === chat.threadId
      )
    ) {
      lines.push({ ...line, kind: "ended" });
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
   * Settled threads before this time were not on the client, so their changes are not listed: a
   * pull request can merge long after its thread settled. Null when every thread was there.
   */
  readonly unloadedBefore: number | null;
}

/**
 * Where the list may be missing changes: threads that settled before `unloadedBefore` were not on
 * the client, so only a window reaching back past it can miss their turns. A late merge on one of
 * them is rare enough to leave unsaid. Null when nothing in the window was left out.
 */
export function sinceLastVisitMissingBefore(captured: CapturedSinceLastVisit): number | null {
  return captured.unloadedBefore !== null && captured.window.since < captured.unloadedBefore
    ? captured.unloadedBefore
    : null;
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

export type SinceLastVisitGroup = "failed" | "reports" | "pullRequests" | "ended";

export interface SinceLastVisitSection<Line> {
  readonly group: SinceLastVisitGroup;
  /** One row per line, or the lines' names joined on one row. */
  readonly display: "rows" | "names";
  readonly lines: ReadonlyArray<Line>;
  readonly total: number;
  readonly hidden: number;
}

/**
 * Up to six changes are one list, newest first. More are grouped, each group newest first: every
 * failure, the three newest reports, and pull requests and turn ends as one row of names, each
 * until expanded.
 */
export function sinceLastVisitLayout<Line extends { readonly at: number }>(
  groups: Readonly<Record<SinceLastVisitGroup, ReadonlyArray<Line>>>,
  expanded: ReadonlySet<SinceLastVisitGroup>,
): {
  readonly total: number;
  readonly grouped: boolean;
  readonly sections: ReadonlyArray<SinceLastVisitSection<Line>>;
  /** Every line, newest first, for the ungrouped list. */
  readonly lines: ReadonlyArray<Line>;
} {
  const order = ["failed", "reports", "pullRequests", "ended"] as const;
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
  return {
    total,
    grouped,
    sections,
    lines: order.flatMap((group) => groups[group]).sort(newestFirst),
  };
}

/** The pull request numbers a report names: a `pr:<number>` key, or `#<number>` in its title. */
function namedPullRequests(line: SinceLastVisitReportLine): number[] {
  const byKey = /^pr:(\d+)$/.exec(line.reportKey);
  const byTitle = [...line.title.matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]));
  return [...(byKey ? [Number(byKey[1])] : []), ...byTitle];
}

/**
 * Splits the window's lines into the card's groups. A report about a pull request that has its own
 * line is one line, the report's, carrying the pull request's number and state.
 */
export function sinceLastVisitGroups(
  threadLines: ReadonlyArray<SinceLastVisitThreadLine>,
  reportLines: ReadonlyArray<SinceLastVisitReportLine>,
): Record<SinceLastVisitGroup, ReadonlyArray<SinceLastVisitLine>> {
  const pullRequestLines = threadLines.filter(
    (line): line is PullRequestLine => line.kind === "merged" || line.kind === "opened",
  );
  // A number shared by pull requests in two repositories does not say which one a report means.
  const byNumber = new Map<number, PullRequestLine | null>();
  for (const line of pullRequestLines)
    byNumber.set(line.number, byNumber.has(line.number) ? null : line);
  const absorbed = new Set<string>();
  const reports = reportLines.map((report) => {
    const matches = [...new Set(namedPullRequests(report))].flatMap((number) => {
      const line = byNumber.get(number);
      return line && !absorbed.has(line.id) ? [line] : [];
    });
    if (matches.length === 0) return report;
    for (const line of matches) absorbed.add(line.id);
    return {
      ...report,
      pullRequests: matches.map((line) => ({
        number: line.number,
        state: line.kind,
        url: line.url,
      })),
    };
  });
  return {
    failed: threadLines.filter((line) => line.kind === "failed" || line.kind === "limited"),
    reports,
    pullRequests: pullRequestLines.filter((line) => !absorbed.has(line.id)),
    ended: threadLines.filter((line) => line.kind === "ended"),
  };
}
