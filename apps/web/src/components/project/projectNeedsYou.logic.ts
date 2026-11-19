import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  ChildThreadApproval,
  PendingThreadRequests,
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  coordinatorReports,
  waitingCoordinatorReports,
} from "@t3tools/client-runtime/coordinator-reports";
import type {
  CoordinatorReport,
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

export function openReports(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "thread">,
): ReadonlyArray<OpenReport> {
  const messages = projection.messages.map((message) => ({
    ...message,
    createdAt: DateTime.formatIso(message.createdAt),
  }));
  return waitingCoordinatorReports(
    coordinatorReports(messages, projection.thread.reportDismissals ?? []),
  ).map(({ message }) => ({
    messageId: message.id,
    report: message.report!,
    createdAt: message.createdAt,
  }));
}

const oldestFirst = (a: ProjectNeed, b: ProjectNeed) =>
  a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key);

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
  return needs.sort(oldestFirst);
}

/**
 * Adds the approvals a thread's subagents and delegated tasks wait on to `needs`, oldest first. A
 * child the project already lists keeps its own rows.
 */
export function withChildApprovals(
  needs: ReadonlyArray<ProjectNeed>,
  approvals: ReadonlyArray<ChildThreadApproval>,
  children: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<ProjectNeed> {
  const listed = new Set(needs.map((need) => `${need.thread.environmentId}:${need.thread.id}`));
  const added: ProjectNeed[] = [];
  for (const { thread: ref, approval } of approvals) {
    const key = `${ref.environmentId}:${ref.threadId}`;
    const thread = children.find(
      (child) => child.environmentId === ref.environmentId && child.id === ref.threadId,
    );
    if (thread === undefined || listed.has(key)) continue;
    added.push({
      kind: "approval",
      key: `${key}:${approval.requestId}`,
      thread,
      createdAt: approval.createdAt,
      approval,
    });
  }
  return added.length === 0 ? needs : [...needs, ...added].sort(oldestFirst);
}
