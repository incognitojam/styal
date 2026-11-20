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
            : tag.resolved
              ? "resolved"
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

/**
 * Each user message about a report, with that report's title and version and the typed text: an
 * answer tied to it, or a reply that only starts with its `formatReportAnswer` prefix.
 */
export function reportAnswers<M extends Message>(messages: readonly M[]) {
  type Answer = {
    readonly messageId: M["id"];
    readonly title: string;
    readonly version: number;
    readonly text: string;
  };
  const reports = new Map<string, M>();
  const byPrefix = new Map<string, M>();
  for (const message of messages)
    if (message.report) {
      reports.set(message.id, message);
      byPrefix.set(formatReportAnswer(message.report, ""), message);
    }
  // The longest matching prefix, as the server picks it for the agent's note.
  const named = (text: string) => {
    if (!text.startsWith("[")) return undefined;
    let found: M | undefined;
    for (let end = text.indexOf("] "); end !== -1; end = text.indexOf("] ", end + 1))
      found = byPrefix.get(text.slice(0, end + 2)) ?? found;
    return found;
  };
  const answers = new Map<M["id"], Answer>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const ref = message.reportAnswer;
    const source = ref ? reports.get(ref.messageId) : named(message.text);
    const report = source?.report;
    if (!source || !report || (ref && report.version !== ref.version)) continue;
    const text = splitReportAnswer(message.text, report);
    if (text !== null)
      answers.set(message.id, {
        messageId: source.id,
        title: report.title,
        version: report.version,
        text,
      });
  }
  return answers;
}

/** The agent's one-line result for an answered report; a resolve from before the answer is not one. */
export function answeredReportResult(
  report: Pick<CoordinatorReport, "resolved">,
  answer: { readonly createdAt: string },
) {
  const { resolved } = report;
  return resolved?.outcome && Date.parse(resolved.at) >= Date.parse(answer.createdAt)
    ? resolved.outcome
    : undefined;
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
