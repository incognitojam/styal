import type {
  CoordinatorReportReference,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";
import {
  acknowledgeReportResponse,
  claimReportResponse,
  failReportResponse,
  pendingReportResponseCount,
  reportResponseFailedMessage,
  reportResponsePending,
  sameReportResponse,
  settleReportResponses,
  type PendingReportResponse,
} from "../reportResponses.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
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
  // Failed responses stay for their message but no longer count.
  if (![...pending.values()].some((list) => pendingReportResponseCount(list) > 0)) return threads;
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
  /**
   * Settles the response with its send's result. A refusal fails it; a success waits for the
   * thread to reach its commit. An interrupted send, or a success without a commit number, may or
   * may not have reached the server, so it waits for the thread's next full sync instead.
   */
  readonly settle: (
    result: AtomCommandResult<{ readonly sequence?: number | undefined }, unknown>,
  ) => void;
  /** Nothing was sent; the report is open again. Ignored once the send has settled. */
  readonly fail: (detail?: string) => void;
}

type Reference = { readonly messageId: string; readonly key: string; readonly version: number };

const isRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** The send was cut off, so the server may or may not have it. */
const outcomeUnknown = (result: AtomCommandResult<unknown, unknown>) => {
  if (isAtomCommandInterrupted(result)) return true;
  const cause = squashAtomCommandFailure(result as Extract<typeof result, { _tag: "Failure" }>);
  return isRpcUnavailable(cause) && cause.outcomeUnknown === true;
};

const sameRef = (a: Reference, b: Reference) =>
  a.messageId === b.messageId && a.key === b.key && a.version === b.version;

/** The thread shows the report answered, dismissed or replaced by a newer version. */
function reportClosed(
  projection: NonNullable<Option.Option.Value<ReportResponseThreadState["data"]>>,
  ref: Reference,
) {
  return (
    projection.messages.some(
      (message) =>
        (message.reportAnswer !== undefined && sameRef(message.reportAnswer, ref)) ||
        (message.report?.key === ref.key && message.report.version > ref.version),
    ) || (projection.thread.reportDismissals ?? []).some((dismissal) => sameRef(dismissal, ref))
  );
}

/**
 * Keeps this client's report responses in `pendingReportResponsesAtom`. A pending one clears when
 * the thread shows it or its thread is deleted, and fails when its send is refused or the thread
 * has caught up without it. A failed one is forgotten once its report is no longer open.
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
      (known.messages.some(
        (message) => message.reportAnswer && sameRef(message.reportAnswer, response.ref),
      ) ||
        (known.thread.reportDismissals ?? []).some((ref) => sameRef(ref, response.ref)))
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
    let settled = false;
    let unconfirmed = false;
    let resyncing = false;
    // The first check runs inside `subscribe`, before `stop` is assigned.
    const finish = () => {
      if (finished) return;
      finished = true;
      queueMicrotask(() => stop?.());
    };
    const check = (state: ReportResponseThreadState) => {
      if (unconfirmed && state.status !== "live") resyncing = true;
      const fullySynced = unconfirmed && resyncing && state.status === "live";
      const projection = Option.getOrNull(state.data);
      if (state.status === "deleted") update(key, () => NO_RESPONSES);
      else if (projection !== null)
        update(key, (current) => {
          const next = settleReportResponses(current, {
            messageIds: projection.messages.map((message) => message.id),
            dismissals: projection.thread.reportDismissals ?? [],
            sequence: state.sequence,
          });
          const judged =
            fullySynced && reportResponsePending(next, response)
              ? failReportResponse(
                  next,
                  response.ref,
                  reportResponseFailedMessage(response),
                  "The server does not have it.",
                )
              : next;
          return reportClosed(projection, response.ref)
            ? judged.filter(
                (entry) => entry.failed === undefined || !sameReportResponse(entry, response),
              )
            : judged;
        });
      const current = registry.get(pendingReportResponsesAtom).get(key) ?? NO_RESPONSES;
      if (!current.some((entry) => sameReportResponse(entry, response))) finish();
    };
    stop = registry.subscribe(threads.stateAtom(thread), check, { immediate: true });
    const fail = (detail?: string) =>
      update(key, (current) =>
        reportResponsePending(current, response)
          ? failReportResponse(current, response.ref, reportResponseFailedMessage(response), detail)
          : current,
      );
    return {
      settle: (result) => {
        settled = true;
        if (result._tag === "Success" && result.value.sequence !== undefined) {
          const sequence = result.value.sequence;
          update(key, (current) => acknowledgeReportResponse(current, response, sequence));
        } else if (result._tag === "Success" || outcomeUnknown(result)) {
          unconfirmed = true;
          update(key, (current) =>
            acknowledgeReportResponse(current, response, Number.POSITIVE_INFINITY),
          );
        } else {
          const cause = squashAtomCommandFailure(result);
          fail(cause instanceof Error ? cause.message : "The server did not accept it.");
        }
        if (!finished) check(registry.get(threads.stateAtom(thread)));
      },
      fail: (detail) => {
        if (settled) return;
        fail(detail);
        if (!finished) check(registry.get(threads.stateAtom(thread)));
      },
    };
  };

  /** Sends one response to a report and shows it at once; false when it was not sent. */
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
    handle.settle(result);
    return result._tag === "Success";
  };

  return { begin, respond };
}
