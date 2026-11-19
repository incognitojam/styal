import type { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "./connection/registry.ts";
import { createEnvironmentRpcCommand } from "./state/runtime.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type CoordinatorReport,
  type CoordinatorReportReference,
} from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

type Reference = { readonly messageId: string; readonly key: string; readonly version: number };
type Message = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly report?: CoordinatorReport | undefined;
  readonly reportAnswer?: Reference | undefined;
};

export function coordinatorReports<M extends Message>(
  messages: readonly M[],
  dismissals: readonly Reference[],
) {
  const latest = new Map<string, M>();
  const referenceKey = (ref: Reference) => JSON.stringify([ref.messageId, ref.key, ref.version]);
  const answers = new Map<string, M>();
  const dismissed = new Set(dismissals.map(referenceKey));
  for (const message of messages) {
    if (message.role === "user" && message.reportAnswer) {
      const key = referenceKey(message.reportAnswer);
      if (!answers.has(key)) answers.set(key, message);
    }
    if (
      message.report &&
      (latest.get(message.report.key)?.report?.version ?? 0) < message.report.version
    )
      latest.set(message.report.key, message);
  }
  return messages.flatMap((message) => {
    const tag = message.report;
    if (!tag) return [];
    const current = latest.get(tag.key)!;
    const key = referenceKey({ messageId: message.id, key: tag.key, version: tag.version });
    const answer = answers.get(key);
    const state =
      current !== message
        ? "replaced"
        : answer
          ? "answered"
          : dismissed.has(key)
            ? "dismissed"
            : tag.question
              ? "open"
              : "posted";
    return [{ message, latest: current, state, answer }];
  });
}

export function formatReportAnswer(
  report: Pick<CoordinatorReport, "title" | "version">,
  text: string,
) {
  return `[${report.title}, version ${report.version}] ${text}`;
}

/** The text after the exact prefix `formatReportAnswer` adds for this report, if it has one. */
export function splitReportAnswer(
  text: string,
  report: Pick<CoordinatorReport, "title" | "version">,
) {
  const prefix = formatReportAnswer(report, "");
  return text.startsWith(prefix) ? text.slice(prefix.length) : null;
}

/**
 * The answer's typed text, and whether it can show as one line: only a tapped answer is,
 * meaning text equal to one of the report's answers with no attachments or context.
 */
export function reportAnswerDisplay(
  answer: { readonly text: string; readonly attachments?: readonly unknown[] | undefined },
  report: Pick<CoordinatorReport, "title" | "version" | "answers">,
) {
  const text = splitReportAnswer(answer.text, report) ?? answer.text;
  const compact =
    (report.answers?.includes(text) ?? false) &&
    (answer.attachments?.length ?? 0) === 0 &&
    collectComposerContextReferences(text).length === 0;
  return { text, compact };
}

/** Each message that answers a report, with that report's title and version and the typed text. */
export function reportAnswers<M extends Message>(messages: readonly M[]) {
  type Answer = {
    readonly messageId: NonNullable<M["reportAnswer"]>["messageId"];
    readonly title: string;
    readonly version: number;
    readonly text: string;
  };
  const reports = new Map<string, CoordinatorReport>();
  for (const message of messages) if (message.report) reports.set(message.id, message.report);
  const answers = new Map<M["id"], Answer>();
  for (const message of messages) {
    const ref = message.role === "user" ? message.reportAnswer : undefined;
    const report = ref ? reports.get(ref.messageId) : undefined;
    if (!ref || !report || report.version !== ref.version) continue;
    const text = splitReportAnswer(message.text, report);
    if (text !== null)
      answers.set(message.id, {
        messageId: ref.messageId,
        title: report.title,
        version: ref.version,
        text,
      });
  }
  return answers;
}

export type ReportReply = { ref: typeof CoordinatorReportReference.Type; title: string };

/**
 * An answer or dismissal this client sent that the server has not shown yet. A report has at
 * most one: while it is pending, further responses are refused, so a double click or a second
 * choice sends nothing. One that failed carries `failed` and no longer counts.
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
) & { readonly failed?: string };

const sameReport = (a: Reference, b: Reference) =>
  a.messageId === b.messageId && a.key === b.key && a.version === b.version;

/** `pending` with `response` added, or null when its report already has a response pending. */
export function claimReportResponse<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
  response: PendingReportResponse<R>,
): readonly PendingReportResponse<R>[] | null {
  if (pending.some((entry) => entry.failed === undefined && sameReport(entry.ref, response.ref)))
    return null;
  return [...pending.filter((entry) => !sameReport(entry.ref, response.ref)), response];
}

/** Marks the report's pending response as failed, which leaves the report open again. */
export function failReportResponse<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
  ref: Reference,
  error: string,
): readonly PendingReportResponse<R>[] {
  return pending.map((entry) => (sameReport(entry.ref, ref) ? { ...entry, failed: error } : entry));
}

/** Why the report's last response failed, while nothing newer is pending for it. */
export function reportResponseFailure(
  pending: readonly PendingReportResponse[],
  ref: Reference,
): string | undefined {
  return pending.find((entry) => sameReport(entry.ref, ref))?.failed;
}

/** Drops the responses the server already shows; returns `pending` when there are none. */
export function settleReportResponses<R extends Reference>(
  pending: readonly PendingReportResponse<R>[],
  server: { readonly messageIds: readonly string[]; readonly dismissals: readonly Reference[] },
): readonly PendingReportResponse<R>[] {
  const settled = (entry: PendingReportResponse<R>) =>
    entry.kind === "answer"
      ? server.messageIds.includes(entry.messageId)
      : server.dismissals.some((ref) => sameReport(ref, entry.ref));
  return pending.some(settled) ? pending.filter((entry) => !settled(entry)) : pending;
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

/**
 * How far an answer has got: still sending (`sending` holds the ids of messages this client has
 * not had confirmed), waiting in the thread's queue behind a running turn, or with the agent.
 */
export function reportAnswerDelivery(
  answerMessageId: string,
  ids: { readonly sending: readonly string[]; readonly queued: readonly string[] },
): "sending" | "queued" | "delivered" {
  if (ids.sending.includes(answerMessageId)) return "sending";
  return ids.queued.includes(answerMessageId) ? "queued" : "delivered";
}

export function waitingCoordinatorReports<M extends Message & { readonly createdAt: string }>(
  reports: Readonly<ReturnType<typeof coordinatorReports<M>>>,
) {
  return reports
    .filter((report) => report.state === "open")
    .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt));
}

export function createDismissCoordinatorReportCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcCommand(runtime, {
    label: "thread:report:dismiss",
    tag: ORCHESTRATION_V2_WS_METHODS.dismissReport,
  });
}
