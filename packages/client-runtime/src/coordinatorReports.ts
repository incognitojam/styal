import type { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "./connection/registry.ts";
import { createEnvironmentRpcCommand } from "./state/runtime.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type CoordinatorReport,
  type CoordinatorReportReference,
} from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

export * from "./reportResponses.ts";

type Reference = { readonly messageId: string; readonly key: string; readonly version: number };
type Message = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly report?: CoordinatorReport | undefined;
  readonly reportAnswer?: (Reference & { readonly typed?: true | undefined }) | undefined;
};

export function coordinatorReports<M extends Message>(
  messages: readonly M[],
  dismissals: readonly Reference[],
) {
  const latest = new Map<string, M>();
  const referenceKey = (ref: Reference) => JSON.stringify([ref.messageId, ref.key, ref.version]);
  // The latest of each: a picked answer closes the question, a typed reply leaves it open.
  const answers = new Map<string, M>();
  const replies = new Map<string, M>();
  const dismissed = new Set(dismissals.map(referenceKey));
  for (const message of messages) {
    if (message.role === "user" && message.reportAnswer) {
      (message.reportAnswer.typed ? replies : answers).set(
        referenceKey(message.reportAnswer),
        message,
      );
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
            : tag.resolved
              ? "resolved"
              : tag.question
                ? "open"
                : "posted";
    return [{ message, latest: current, state, answer, reply: replies.get(key) }];
  });
}

/**
 * A typed reply's reference: it reaches the agent without closing the question. A server that
 * does not advertise `reportReplies` would count it as an answer, so it gets none.
 */
export function reportReplyReference<R extends Reference>(
  ref: R,
  serverConfig: { readonly reportReplies?: boolean } | null | undefined,
) {
  return serverConfig?.reportReplies === true ? { ...ref, typed: true as const } : undefined;
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
