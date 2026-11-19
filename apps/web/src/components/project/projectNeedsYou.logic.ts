import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  PendingThreadRequests,
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  coordinatorReports,
  pendingReportAnswers,
  pendingReportDismissals,
  reportResponseFailure,
  reportResponsePending,
  splitReportAnswer,
  waitingCoordinatorReports,
  type PendingReportResponse,
} from "@t3tools/client-runtime/coordinator-reports";
import { getUserQueuedThreadRuns } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  CoordinatorReport,
  CoordinatorReportReference,
  MessageId,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface OpenReport {
  readonly messageId: MessageId;
  readonly report: CoordinatorReport;
  readonly createdAt: string;
}

/** What one thread waits on, once its detail has loaded. */
export interface ThreadNeeds {
  readonly requests: PendingThreadRequests;
  readonly reports: ReadonlyArray<OpenReport>;
  /** A report response from this client is on its way, so the server's count is behind. */
  readonly responding?: boolean;
}

interface NeedBase {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly createdAt: string;
}

export type ProjectNeed = NeedBase &
  (
    | { readonly kind: "approval"; readonly approval: ThreadPendingApproval }
    | { readonly kind: "question"; readonly userInput: ThreadPendingUserInput }
    | { readonly kind: "report"; readonly report: OpenReport }
    /** Waits on something only its own page answers, such as a subagent's request or a secret. */
    | { readonly kind: "thread" }
  );

/** Report questions still waiting, counting responses this client has sent as given. */
export function openReports(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "thread">,
  pending: ReadonlyArray<PendingReportResponse<typeof CoordinatorReportReference.Type>> = [],
): ReadonlyArray<OpenReport> {
  const messages = projection.messages.map((message) => ({
    ...message,
    createdAt: DateTime.formatIso(message.createdAt),
  }));
  return waitingCoordinatorReports(
    coordinatorReports(
      [...messages, ...pendingReportAnswers(pending)],
      [...(projection.thread.reportDismissals ?? []), ...pendingReportDismissals(pending)],
    ),
  ).map(({ message }) => ({
    messageId: message.id,
    report: message.report!,
    createdAt: message.createdAt,
  }));
}

/**
 * Every request from the threads the status line counts, oldest first. A thread whose detail is
 * still loading is left out until it loads.
 */
export function listProjectNeeds(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  needsOf: (thread: EnvironmentThreadShell) => ThreadNeeds | null,
): ReadonlyArray<ProjectNeed> {
  const needs: ProjectNeed[] = [];
  for (const thread of threads) {
    const loaded = needsOf(thread);
    if (loaded === null) continue;
    const key = `${thread.environmentId}:${thread.id}`;
    const own: ProjectNeed[] = [
      ...loaded.requests.approvals.map((approval) => ({
        kind: "approval" as const,
        key: `${key}:${approval.requestId}`,
        thread,
        createdAt: approval.createdAt,
        approval,
      })),
      ...loaded.requests.userInputs.map((userInput) => ({
        kind: "question" as const,
        key: `${key}:${userInput.requestId}`,
        thread,
        createdAt: userInput.createdAt,
        userInput,
      })),
      ...loaded.reports.map((report) => ({
        kind: "report" as const,
        key: `${key}:${report.messageId}`,
        thread,
        createdAt: report.createdAt,
        report,
      })),
    ];
    if (own.length === 0 && loaded.responding) continue;
    needs.push(
      ...(own.length > 0
        ? own
        : [
            {
              kind: "thread" as const,
              key,
              thread,
              createdAt: thread.pendingUserInputAt ?? thread.updatedAt,
            },
          ]),
    );
  }
  return needs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}

/**
 * How far a report response sent from the "Needs you" card has got: still sending or
 * dismissing, waiting in the thread's queue behind a running turn, with the agent ("delivered"),
 * failed, or withdrawn (cancelled in the queue, which leaves the message without its report
 * reference). While it is on its way, the row keeps its answering shape with the answer marked.
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
  | "withdrawn" {
  const { report, response } = answered;
  const text =
    response.kind === "answer" ? (splitReportAnswer(response.text, report) ?? response.text) : null;
  const offered = text !== null && (report.answers?.includes(text) ?? false);
  const shape = { chosen: offered ? text : null, reply: offered ? null : text };
  if (reportResponsePending(responses, response))
    return { status: response.kind === "dismiss" ? "dismissing" : "sending", ...shape };
  if (reportResponseFailure(responses, response.ref) !== undefined) return "failed";
  if (
    response.kind === "answer" &&
    projection !== null &&
    getUserQueuedThreadRuns(projection).some((run) => run.userMessageId === response.messageId)
  )
    return { status: "queued", ...shape };
  if (response.kind === "answer" && projection !== null) {
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
