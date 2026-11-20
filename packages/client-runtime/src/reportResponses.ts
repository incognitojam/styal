import type { CoordinatorReport } from "@t3tools/contracts";

type Reference = { readonly messageId: string; readonly key: string; readonly version: number };

export const REPORT_ANSWER_FAILED = "Your answer was not sent.";
export const REPORT_REPLY_FAILED = "Your reply was not sent.";
const REPORT_DISMISS_FAILED = "The report was not dismissed.";

/**
 * A response this client sent that the server does not show yet; one per report, so further
 * responses to it are refused. `failed` ones no longer count; `acknowledgedAt` is the commit
 * sequence the server answered the send with.
 */
export type PendingReportResponse<R extends Reference = Reference> = (
  | {
      readonly ref: R;
      readonly kind: "answer";
      readonly messageId: R["messageId"];
      readonly text: string;
      readonly createdAt: string;
      /** The typed text, when typed rather than one of the offered answers. */
      readonly reply?: string;
    }
  | { readonly ref: R; readonly kind: "dismiss" }
) & {
  readonly failed?: string;
  readonly failedDetail?: string;
  readonly acknowledgedAt?: number;
};

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

/** What a failed `response` says. */
export function reportResponseFailedMessage(response: PendingReportResponse): string {
  return response.kind === "dismiss"
    ? REPORT_DISMISS_FAILED
    : response.reply
      ? REPORT_REPLY_FAILED
      : REPORT_ANSWER_FAILED;
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

/** Whether `response` is still pending in `pending`: neither settled nor failed. */
export function reportResponsePending(
  pending: readonly PendingReportResponse[],
  response: PendingReportResponse,
): boolean {
  return pending.some((entry) => entry.failed === undefined && sameReportResponse(entry, response));
}

/**
 * How many responses in `pending` are still on their way and missing from a view that reflects
 * commits up to `reflectedThrough`, when that is known.
 */
export function pendingReportResponseCount(
  pending: readonly PendingReportResponse[],
  reflectedThrough?: number,
): number {
  return pending.filter(
    (entry) =>
      entry.failed === undefined &&
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
  if (pending.some((entry) => entry.failed === undefined && sameReport(entry.ref, response.ref)))
    return null;
  return [...pending.filter((entry) => !sameReport(entry.ref, response.ref)), response];
}

/** Records the commit sequence the server acknowledged `response` with. */
export function acknowledgeReportResponse<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
  response: PendingReportResponse<R>,
  sequence: number,
): readonly PendingReportResponse<R>[] {
  return pending.map((entry) =>
    entry.failed === undefined && sameReportResponse(entry, response)
      ? { ...entry, acknowledgedAt: sequence }
      : entry,
  );
}

/** Marks the report's pending response as failed, which leaves the report open again. */
export function failReportResponse<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
  ref: Reference,
  error: string,
  detail?: string,
): readonly PendingReportResponse<R>[] {
  return pending.map((entry) =>
    sameReport(entry.ref, ref)
      ? { ...entry, failed: error, ...(detail === undefined ? {} : { failedDetail: detail }) }
      : entry,
  );
}

/** Why the report's last response failed, while nothing newer is pending for it. */
export function reportResponseFailure(
  pending: readonly PendingReportResponse[],
  ref: Reference,
): { readonly message: string; readonly detail?: string } | undefined {
  const entry = pending.find((candidate) => sameReport(candidate.ref, ref));
  return entry?.failed === undefined
    ? undefined
    : {
        message: entry.failed,
        ...(entry.failedDetail === undefined ? {} : { detail: entry.failedDetail }),
      };
}

/**
 * Settles `pending` against the server's view of the thread: drops responses it shows (a queued
 * answer the user cancels stays as a message without its report reference, so it is dropped too),
 * and fails acknowledged ones it does not show once its view has reached their commit, since
 * they will not arrive. Returns `pending` when nothing changes.
 */
export function settleReportResponses<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
  server: {
    readonly messageIds: readonly string[];
    readonly dismissals: readonly Reference[];
    /** The commit sequence `messageIds` and `dismissals` reflect, when known. */
    readonly sequence?: number;
  },
): readonly PendingReportResponse<R>[] {
  const shown = (entry: PendingReportResponse<R>) =>
    entry.kind === "answer"
      ? server.messageIds.includes(entry.messageId)
      : server.dismissals.some((ref) => sameReport(ref, entry.ref));
  const lost = (entry: PendingReportResponse<R>) =>
    entry.failed === undefined &&
    entry.acknowledgedAt !== undefined &&
    server.sequence !== undefined &&
    server.sequence >= entry.acknowledgedAt;
  if (!pending.some((entry) => shown(entry) || lost(entry))) return pending;
  return pending.flatMap((entry) =>
    shown(entry)
      ? []
      : lost(entry)
        ? [
            {
              ...entry,
              failed: reportResponseFailedMessage(entry),
              failedDetail: "The server does not have it.",
            },
          ]
        : [entry],
  );
}

/** Pending answers as user messages, for `coordinatorReports` to read like confirmed ones. */
export function pendingReportAnswers<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
) {
  return pending.flatMap((entry) =>
    entry.kind === "answer" && entry.failed === undefined
      ? [
          {
            id: entry.messageId,
            role: "user" as const,
            text: entry.text,
            report: undefined as CoordinatorReport | undefined,
            reportAnswer: entry.ref,
            createdAt: entry.createdAt,
          },
        ]
      : [],
  );
}

/** Pending dismissals, for `coordinatorReports` to read like confirmed ones. */
export function pendingReportDismissals<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
): R[] {
  return pending.flatMap((entry) =>
    entry.kind === "dismiss" && entry.failed === undefined ? [entry.ref] : [],
  );
}
