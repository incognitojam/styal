import type { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "./connection/registry.ts";
import { createEnvironmentRpcCommand } from "./state/runtime.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type CoordinatorReport,
  type CoordinatorReportReference,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  reportResponseFailure,
  reportResponsePending,
  type PendingReportResponse,
} from "./reportResponses.ts";
import { getUserQueuedThreadRuns } from "./state/threadWorkflows.ts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

export * from "./reportResponses.ts";

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

/**
 * How far a response sent from a "Needs you" list has got. Sending, dismissing and queued keep
 * the row's answering shape; "withdrawn" is an answer cancelled in the queue (its message stays
 * without the report reference), and "unknown" means the thread has not loaded yet.
 */
export function answeredReportStatus(
  answered: {
    readonly report: CoordinatorReport;
    readonly response: PendingReportResponse<typeof CoordinatorReportReference.Type>;
  },
  responses: ReadonlyArray<PendingReportResponse<typeof CoordinatorReportReference.Type>>,
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> | null,
):
  | {
      readonly status: "sending" | "queued" | "dismissing";
      readonly chosen: string | null;
      readonly reply: string | null;
    }
  | "delivered"
  | "failed"
  | "withdrawn"
  | "unknown" {
  const { report, response } = answered;
  const text =
    response.kind === "answer" ? (splitReportAnswer(response.text, report) ?? response.text) : null;
  const offered = text !== null && (report.answers?.includes(text) ?? false);
  const shape = { chosen: offered ? text : null, reply: offered ? null : text };
  if (reportResponsePending(responses, response))
    return { status: response.kind === "dismiss" ? "dismissing" : "sending", ...shape };
  if (reportResponseFailure(responses, response.ref) !== undefined) return "failed";
  if (projection === null) return "unknown";
  if (
    response.kind === "answer" &&
    getUserQueuedThreadRuns(projection).some((run) => run.userMessageId === response.messageId)
  )
    return { status: "queued", ...shape };
  if (response.kind === "answer") {
    const ref = projection.messages.find(
      (message) => message.id === response.messageId,
    )?.reportAnswer;
    if (
      ref === undefined ||
      ref.messageId !== response.ref.messageId ||
      ref.key !== response.ref.key ||
      ref.version !== response.ref.version
    )
      return "withdrawn";
  }
  return "delivered";
}

/**
 * The "Needs you" rows: each open need, and each response sent from the page that is still on
 * its way, kept in its place among them so the list does not move until it is delivered.
 */
export function needRowsWithResponses<
  N extends { readonly key: string; readonly createdAt: string },
  R,
>(
  needs: ReadonlyArray<N>,
  responding: ReadonlyArray<{ readonly need: N; readonly responding: R }>,
): Array<{ readonly need: N; readonly responding?: R }> {
  const keys = new Set(responding.map((row) => row.need.key));
  return [
    ...needs.filter((need) => !keys.has(need.key)).map((need) => ({ need })),
    ...responding,
  ].sort(
    (a, b) =>
      a.need.createdAt.localeCompare(b.need.createdAt) || a.need.key.localeCompare(b.need.key),
  );
}
