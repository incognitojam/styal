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
  waitingCoordinatorReports,
  type PendingReportResponse,
} from "@t3tools/client-runtime/coordinator-reports";
import type {
  CoordinatorReport,
  CoordinatorReportReference,
  MessageId,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isLatestFailureSeen, resolveThreadLastVisitedAt } from "../Sidebar.logic";

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
    | { readonly kind: "failed"; readonly error: string | null }
    | { readonly kind: "limited"; readonly resetAt: string | null }
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
 * The failed and usage-limited threads the user hasn't dealt with. One leaves once it is settled
 * or opened after it stopped, when its sidebar row recedes too.
 */
export function stoppedThreadsNeedingYou(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  localVisitedAt: (thread: EnvironmentThreadShell) => string | undefined,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter((thread) => {
    const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localVisitedAt(thread));
    return thread.settledAt == null && !isLatestFailureSeen({ ...thread, lastVisitedAt });
  });
}

/** Rows for {@link stoppedThreadsNeedingYou}, oldest first. */
export function listStoppedThreadNeeds(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<ProjectNeed> {
  const needs: ProjectNeed[] = [];
  for (const thread of threads) {
    const base = {
      key: `${thread.environmentId}:${thread.id}`,
      thread,
      createdAt: thread.latestRun?.completedAt ?? thread.runtime?.updatedAt ?? thread.updatedAt,
    };
    needs.push(
      thread.runtime?.lastErrorClass === "usage_limit"
        ? { ...base, kind: "limited", resetAt: thread.runtime.usageLimitResetAt ?? null }
        : {
            ...base,
            kind: "failed",
            error: thread.runtime?.lastError?.trim().split("\n")[0]?.trim() || null,
          },
    );
  }
  return needs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}
