import type { MessageId } from "@t3tools/contracts";

/**
 * A report opened from a project's Needs you list. `returnTo` is the key of the project chat's
 * route that pushed this thread; null when the report is the chat's own and its list is here.
 */
export interface OpenedReport {
  readonly threadKey: string;
  readonly id: MessageId;
  readonly returnTo: string | null;
}

type ReportLike = { readonly message: { readonly id: string }; readonly state: string };

/**
 * The opened report as this thread's reports have it, or null when it is not this thread's or
 * no longer listed. Its answers stay hidden while the composer is replying to it.
 */
export function openedReportView<R extends ReportLike>(
  opened: OpenedReport | null,
  threadKey: string,
  reports: readonly R[],
  replyingTo: string | null,
): { readonly report: R; readonly visible: boolean } | null {
  if (opened === null || opened.threadKey !== threadKey) return null;
  const report = reports.find((entry) => entry.message.id === opened.id);
  return report === undefined ? null : { report, visible: replyingTo !== opened.id };
}

/** An answer or a dismissal is on record, from here or anywhere else: back to the list. */
export function openedReportFinished(report: ReportLike): boolean {
  return report.state === "answered" || report.state === "dismissed";
}

/** The project chat to go back to: only the route the list was opened from, right below. */
export function needsListRoute(
  state: { readonly index: number; readonly routes: ReadonlyArray<{ readonly key: string }> },
  returnTo: string,
): string | null {
  return state.routes[state.index - 1]?.key === returnTo ? returnTo : null;
}
