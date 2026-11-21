import type { CoordinatorReport } from "@t3tools/contracts";

type Reference = { readonly messageId: string; readonly key: string; readonly version: number };

/**
 * A response this client sent that the thread list does not reflect yet; one per report, so
 * further responses to it are refused. `acknowledgedAt` is the commit sequence that holds it,
 * or infinity while its outcome is unknown.
 */
export type PendingReportResponse<R extends Reference = Reference> = (
  | {
      readonly ref: R;
      readonly kind: "answer";
      readonly messageId: R["messageId"];
      readonly text: string;
      readonly createdAt: string;
    }
  | { readonly ref: R; readonly kind: "dismiss" }
) & { readonly acknowledgedAt?: number };

const sameReport = (a: Reference, b: Reference) =>
  a.messageId === b.messageId && a.key === b.key && a.version === b.version;

/** The same response: same report, and for an answer the same message. */
export function sameReportResponse(a: PendingReportResponse, b: PendingReportResponse): boolean {
  return (
    sameReport(a.ref, b.ref) &&
    a.kind === b.kind &&
    (a.kind === "dismiss" || (b.kind === "answer" && a.messageId === b.messageId))
  );
}

/** Whether the server shows `response`: its answer message still tied to the report, or the dismissal. */
export function reportResponseDelivered(
  server: {
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly reportAnswer?: Reference | undefined;
    }>;
    readonly dismissals: readonly Reference[];
  },
  response: PendingReportResponse,
): boolean {
  if (response.kind === "dismiss")
    return server.dismissals.some((ref) => sameReport(ref, response.ref));
  return server.messages.some(
    (message) =>
      message.id === response.messageId &&
      message.reportAnswer !== undefined &&
      sameReport(message.reportAnswer, response.ref),
  );
}

/** Whether `response` is still in `pending`. */
export function reportResponsePending(
  pending: readonly PendingReportResponse[],
  response: PendingReportResponse,
): boolean {
  return pending.some((entry) => sameReportResponse(entry, response));
}

/**
 * How many responses in `pending` are missing from a view that reflects commits up to
 * `reflectedThrough`, when that is known.
 */
export function pendingReportResponseCount(
  pending: readonly PendingReportResponse[],
  reflectedThrough?: number,
): number {
  return pending.filter(
    (entry) =>
      !(
        reflectedThrough !== undefined &&
        entry.acknowledgedAt !== undefined &&
        entry.acknowledgedAt <= reflectedThrough
      ),
  ).length;
}

/** `pending` with `response` added, or null when its report already has a response pending. */
export function claimReportResponse<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
  response: PendingReportResponse<R>,
): readonly PendingReportResponse<R>[] | null {
  if (pending.some((entry) => sameReport(entry.ref, response.ref))) return null;
  return [...pending, response];
}

/** Records the commit sequence that holds `response`. */
export function acknowledgeReportResponse<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
  response: PendingReportResponse<R>,
  sequence: number,
): readonly PendingReportResponse<R>[] {
  return pending.map((entry) =>
    sameReportResponse(entry, response) ? { ...entry, acknowledgedAt: sequence } : entry,
  );
}

/** Pending answers as user messages, for `coordinatorReports` to read like confirmed ones. */
export function pendingReportAnswers<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
) {
  return pending.flatMap((entry) =>
    entry.kind === "answer"
      ? [
          {
            id: entry.messageId,
            role: "user" as const,
            text: entry.text,
            report: undefined as CoordinatorReport | undefined,
            reportAnswer: entry.ref,
            createdAt: entry.createdAt,
            pending: true as const,
          },
        ]
      : [],
  );
}

/** Pending dismissals, for `coordinatorReports` to read like confirmed ones. */
export function pendingReportDismissals<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
): R[] {
  return pending.flatMap((entry) => (entry.kind === "dismiss" ? [entry.ref] : []));
}
