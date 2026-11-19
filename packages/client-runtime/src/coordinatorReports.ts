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

/** An answer this client sent that the server's messages don't include yet. */
export type PendingReportAnswer = { readonly text: string; readonly reportAnswer: Reference };

export function coordinatorReports<
  M extends Message,
  P extends PendingReportAnswer = PendingReportAnswer,
>(messages: readonly M[], dismissals: readonly Reference[], pending: readonly P[] = []) {
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
    const pendingAnswer = answer
      ? undefined
      : pending.find((entry) => referenceKey(entry.reportAnswer) === key);
    const state =
      current !== message
        ? "replaced"
        : answer
          ? "answered"
          : pendingAnswer
            ? "sending"
            : dismissed.has(key)
              ? "dismissed"
              : tag.question
                ? "open"
                : "posted";
    return [{ message, latest: current, state, answer, pending: pendingAnswer }];
  });
}

/**
 * Whether an answer to `ref` can still go: its report is open, with no answer recorded, sent or
 * on its way. A report version takes one answer.
 */
export function reportAcceptsAnswer(
  reports: ReadonlyArray<{ readonly message: { readonly id: string }; readonly state: string }>,
  ref: Reference,
): boolean {
  return reports.some((report) => report.message.id === ref.messageId && report.state === "open");
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
