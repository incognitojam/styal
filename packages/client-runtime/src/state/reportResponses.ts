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
  pendingReportResponseCount,
  sameReportResponse,
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

/** Report responses sent from this client that the thread list does not reflect yet, by thread key. */
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
  /**
   * Settles the response with its send's result. A refusal reverts it; a success waits for the
   * thread to reach its commit. An interrupted send, or a success without a commit number, may or
   * may not have reached the server, so it waits for the thread's next full sync instead.
   */
  readonly settle: (
    result: AtomCommandResult<{ readonly sequence?: number | undefined }, unknown>,
  ) => void;
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

type ThreadProjection = NonNullable<Option.Option.Value<ReportResponseThreadState["data"]>>;

/** The thread shows the answer message (tied to the report or not) or the dismissal. */
const shows = (projection: ThreadProjection, response: ReportResponse) =>
  response.kind === "answer"
    ? projection.messages.some((message) => message.id === response.messageId)
    : (projection.thread.reportDismissals ?? []).some((ref) => sameRef(ref, response.ref));

/**
 * Keeps this client's report responses in `pendingReportResponsesAtom`. A response is dropped
 * once the thread list reflects it or its thread is deleted, and dropped with `onFailed` when its
 * send is refused or the thread has caught up without it.
 */
export function createReportResponses(
  registry: AtomRegistry.AtomRegistry,
  threads: {
    readonly stateAtom: (ref: ScopedThreadRef) => Atom.Atom<ReportResponseThreadState>;
    /** The thread list whose counts the pending responses lower. */
    readonly snapshotAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<{ readonly snapshotSequence: number } | null>;
    readonly onFailed: (response: ReportResponse, detail?: string) => void;
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
    const remove = () =>
      update(key, (current) => current.filter((entry) => !sameReportResponse(entry, response)));
    let stop: (() => void) | undefined;
    let finished = false;
    let acknowledgedAt: number | undefined;
    let unconfirmed = false;
    let resyncing = false;
    // The first check runs inside `subscribe`, before `stop` is assigned.
    const finish = () => {
      finished = true;
      queueMicrotask(() => stop?.());
    };
    const fail = (detail?: string) => {
      finish();
      remove();
      threads.onFailed(response, detail);
    };
    // The thread list arrives on its own stream, so it may not count the response yet.
    const list = threads.snapshotAtom(thread.environmentId);
    let listedAt: number | undefined;
    let stopList: (() => void) | undefined;
    const listed = (snapshot: { readonly snapshotSequence: number } | null) =>
      snapshot === null || snapshot.snapshotSequence >= listedAt!;
    const dropOnceListed = (sequence: number) => {
      listedAt = Math.min(listedAt ?? sequence, sequence);
      update(key, (current) => acknowledgeReportResponse(current, response, listedAt!));
      if (listed(registry.get(list))) {
        stopList?.();
        return remove();
      }
      stopList ??= registry.subscribe(list, (snapshot) => {
        if (!listed(snapshot)) return;
        remove();
        queueMicrotask(() => stopList?.());
      });
    };
    const check = (state: ReportResponseThreadState) => {
      if (finished) return;
      if (state.status === "deleted") {
        finish();
        return remove();
      }
      if (unconfirmed && state.status !== "live") resyncing = true;
      const projection = Option.getOrNull(state.data);
      if (projection === null) return;
      if (shows(projection, response)) {
        finish();
        return dropOnceListed(Math.min(acknowledgedAt ?? state.sequence, state.sequence));
      }
      // A full sync is the server's whole view; one without the response means it did not arrive.
      if (
        (acknowledgedAt !== undefined && state.sequence >= acknowledgedAt) ||
        (unconfirmed && resyncing && state.status === "live")
      )
        fail("The server did not receive it.");
    };
    stop = registry.subscribe(threads.stateAtom(thread), check, { immediate: true });
    return {
      settle: (result) => {
        if (finished) {
          // Shown before the reply came back; its own commit may be earlier than the thread's.
          if (
            listedAt !== undefined &&
            result._tag === "Success" &&
            result.value.sequence !== undefined
          )
            dropOnceListed(result.value.sequence);
          return;
        }
        if (result._tag === "Success" && result.value.sequence !== undefined) {
          acknowledgedAt = result.value.sequence;
          update(key, (current) => acknowledgeReportResponse(current, response, acknowledgedAt!));
        } else if (result._tag === "Success" || outcomeUnknown(result)) {
          unconfirmed = true;
          update(key, (current) =>
            acknowledgeReportResponse(current, response, Number.POSITIVE_INFINITY),
          );
        } else {
          const cause = squashAtomCommandFailure(result);
          return fail(cause instanceof Error ? cause.message : undefined);
        }
        check(registry.get(threads.stateAtom(thread)));
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
