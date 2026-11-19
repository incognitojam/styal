import type {
  CoordinatorReportReference,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { coordinatorReports } from "../coordinatorReports.ts";
import {
  acknowledgeReportResponse,
  claimReportResponse,
  failReportResponse,
  pendingReportResponseCount,
  REPORT_ANSWER_FAILED,
  REPORT_DISMISS_FAILED,
  reportResponsePending,
  settleReportResponses,
  type PendingReportResponse,
} from "../reportResponses.ts";
import { threadKey } from "./entities.ts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

/** What the store reads of a thread: its data, whether it was deleted, and the commit it reflects. */
export type ReportResponseThreadState = Pick<
  EnvironmentThreadState,
  "data" | "status" | "sequence"
>;

export type ReportResponse = PendingReportResponse<typeof CoordinatorReportReference.Type>;

const NO_RESPONSES: readonly ReportResponse[] = [];

/** Report responses sent from this client that the server does not show yet, by thread key. */
export const pendingReportResponsesAtom = Atom.make<ReadonlyMap<string, readonly ReportResponse[]>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("report-responses:pending"));

export const threadReportResponsesAtom = Atom.family((key: string) =>
  Atom.make((get) => get(pendingReportResponsesAtom).get(key) ?? NO_RESPONSES),
);

/**
 * Lowers each thread's open report question count by the responses still on its way from this
 * client, so thread lists and counts drop a question as soon as it is answered. A response
 * the shell has already counted (it reflects the commit the send was acknowledged at) is not
 * subtracted again.
 */
export function withPendingReportResponses(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  pending: ReadonlyMap<string, readonly ReportResponse[]>,
  snapshotSequence?: number,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  if (pending.size === 0) return threads;
  let changed = false;
  const next = threads.map((thread) => {
    const open = thread.openReportQuestionCount ?? 0;
    const responding = pendingReportResponseCount(
      pending.get(threadKey({ environmentId, threadId: thread.id })) ?? NO_RESPONSES,
      snapshotSequence,
    );
    if (open === 0 || responding === 0) return thread;
    changed = true;
    const remaining = Math.max(0, open - responding);
    return {
      ...thread,
      openReportQuestionCount: remaining,
      ...(remaining === 0 ? { latestOpenReportQuestionAt: null } : {}),
    };
  });
  return changed ? next : threads;
}

export interface ReportResponseHandle {
  /** The send went through; the server committed it at `sequence`, when its reply says. */
  readonly acknowledge: (sequence: number | undefined) => void;
  /** The send failed; the report is open again with `message`, and `detail` behind it. */
  readonly fail: (message: string, detail?: string) => void;
}

/**
 * Keeps this client's report responses in `pendingReportResponsesAtom` and clears each one
 * when the thread shows it, when the thread is deleted, when its send fails, or when the
 * thread's data has caught up with the send's commit without showing it.
 */
export function createReportResponses(
  registry: AtomRegistry.AtomRegistry,
  threads: {
    readonly stateAtom: (ref: ScopedThreadRef) => Atom.Atom<ReportResponseThreadState>;
  },
) {
  const update = (
    key: string,
    change: (current: readonly ReportResponse[]) => readonly ReportResponse[],
  ) =>
    registry.update(pendingReportResponsesAtom, (all) => {
      const current = all.get(key) ?? NO_RESPONSES;
      const next = change(current);
      if (next === current) return all;
      const copy = new Map(all);
      if (next.length === 0) copy.delete(key);
      else copy.set(key, next);
      return copy;
    });

  /**
   * Shows `response` at once; null when its report already has a response pending, or the
   * thread already shows one (a screen that has fallen behind may still offer the buttons).
   */
  const begin = (
    thread: ScopedThreadRef,
    response: ReportResponse,
  ): ReportResponseHandle | null => {
    const known = Option.getOrNull(registry.get(threads.stateAtom(thread)).data);
    if (
      known !== null &&
      coordinatorReports(known.messages, known.thread.reportDismissals ?? []).some(
        ({ message, state }) =>
          message.id === response.ref.messageId &&
          message.report?.key === response.ref.key &&
          message.report.version === response.ref.version &&
          (state === "answered" || state === "dismissed"),
      )
    )
      return null;
    const key = threadKey(thread);
    let claimed = false;
    update(key, (current) => {
      const next = claimReportResponse(current, response);
      claimed = next !== null;
      return next ?? current;
    });
    if (!claimed) return null;
    let stop: (() => void) | undefined;
    let finished = false;
    // A success reply without a commit number leaves only a full sync of the thread to compare with.
    let acknowledgedWithoutSequence = false;
    let resyncing = false;
    // The first check runs inside `subscribe`, before `stop` is assigned.
    const finish = () => {
      if (finished) return;
      finished = true;
      queueMicrotask(() => stop?.());
    };
    const check = (state: ReportResponseThreadState) => {
      if (acknowledgedWithoutSequence && state.status !== "live") resyncing = true;
      const fullySynced = acknowledgedWithoutSequence && resyncing && state.status === "live";
      const projection = Option.getOrNull(state.data);
      if (state.status === "deleted") update(key, () => NO_RESPONSES);
      else if (projection !== null)
        update(key, (current) =>
          settleReportResponses(current, {
            messageIds: projection.messages.map((message) => message.id),
            dismissals: projection.thread.reportDismissals ?? [],
            sequence: fullySynced ? Number.POSITIVE_INFINITY : state.sequence,
          }),
        );
      if (!reportResponsePending(registry.get(pendingReportResponsesAtom).get(key) ?? [], response))
        finish();
    };
    stop = registry.subscribe(threads.stateAtom(thread), check, { immediate: true });
    return {
      acknowledge: (sequence) => {
        if (sequence === undefined) acknowledgedWithoutSequence = true;
        update(key, (current) =>
          acknowledgeReportResponse(current, response, sequence ?? Number.POSITIVE_INFINITY),
        );
        if (!finished) check(registry.get(threads.stateAtom(thread)));
      },
      fail: (message, detail) => {
        update(key, (current) =>
          reportResponsePending(current, response)
            ? failReportResponse(current, response.ref, message, detail)
            : current,
        );
        finish();
      },
    };
  };

  /**
   * Sends one response to a report and shows it at once. Returns false without sending when the
   * report already has a response pending; a failed send leaves the report open with one clear
   * message and the server's reason, when it gave one, as detail.
   */
  const respond = async (
    thread: ScopedThreadRef,
    response: ReportResponse,
    send: () => Promise<AtomCommandResult<{ readonly sequence?: number | undefined }, unknown>>,
    /** Runs once the response is shown, before it is sent. */
    onClaimed?: () => void,
  ): Promise<boolean> => {
    const handle = begin(thread, response);
    if (handle === null) return false;
    onClaimed?.();
    const result = await send();
    if (result._tag === "Success") {
      handle.acknowledge(result.value.sequence);
      return true;
    }
    const cause = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
    handle.fail(
      response.kind === "answer" ? REPORT_ANSWER_FAILED : REPORT_DISMISS_FAILED,
      cause instanceof Error ? cause.message : undefined,
    );
    return false;
  };

  return { begin, respond };
}
