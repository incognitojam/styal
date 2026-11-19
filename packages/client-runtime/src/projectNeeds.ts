import type { EnvironmentThreadShell } from "./state/models.ts";
import type {
  PendingThreadRequests,
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "./state/threadRequests.ts";
import { coordinatorReports, waitingCoordinatorReports } from "./coordinatorReports.ts";
import type {
  CoordinatorReport,
  MessageId,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { deriveToolRowPresentation } from "@t3tools/shared/toolRowPresentation";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { parseThreadKey } from "./state/entities.ts";
import type { createEnvironmentThreadDetailAtoms } from "./state/threadDetail.ts";

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
  return needs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}

/**
 * What each listed thread waits on, keyed by `threadKey` and read from `keys` joined by newlines.
 * Only threads that need you are passed in, so only they stream their thread detail.
 */
export function createProjectNeedsAtom(
  details: Pick<
    ReturnType<typeof createEnvironmentThreadDetailAtoms>,
    "pendingRequestsAtom" | "stateAtom"
  >,
) {
  const threadNeedsAtom = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previous: readonly unknown[] = [];
    let value: ThreadNeeds | null = null;
    return Atom.make((get) => {
      const requests = get(details.pendingRequestsAtom(ref));
      const projection = Option.getOrNull(get(details.stateAtom(ref)).data);
      if (requests === null || projection === null) return null;
      const inputs = [requests, projection.messages, projection.thread.reportDismissals];
      if (inputs.some((input, index) => input !== previous[index])) {
        previous = inputs;
        value = { requests, reports: openReports(projection) };
      }
      return value;
    });
  });
  return Atom.family((keys: string) =>
    Atom.make((get) => {
      const needs = new Map<string, ThreadNeeds | null>();
      for (const key of keys.split("\n")) if (key) needs.set(key, get(threadNeedsAtom(key)));
      return needs;
    }),
  );
}

const APPROVAL_HEADINGS = {
  command: "Run command",
  "file-change": "Change files",
  "file-read": "Read file",
  permission: "Permission",
  "mcp-elicitation": "App access",
} satisfies Record<ThreadPendingApproval["requestKind"], string>;

/** One line for a need: what it asks, as its row and the project chat's bar show it. */
export function projectNeedSummary(need: ProjectNeed): string {
  switch (need.kind) {
    case "approval": {
      const { approval } = need;
      const heading =
        (approval.toolName
          ? deriveToolRowPresentation({ toolName: approval.toolName, input: approval.toolInput })
              ?.heading
          : undefined) ?? APPROVAL_HEADINGS[approval.requestKind];
      return approval.detail ? `${heading}: ${approval.detail}` : heading;
    }
    case "question":
      return need.userInput.questions[0]?.question ?? "A question";
    case "report":
      return need.report.report.question ?? need.report.report.title;
    case "thread":
      return need.thread.pendingSubagentRequest
        ? "A subagent is waiting for you"
        : "Waiting for you in its thread";
  }
}
