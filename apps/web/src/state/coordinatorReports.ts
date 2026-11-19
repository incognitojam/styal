import {
  claimReportResponse,
  createDismissCoordinatorReportCommand,
  failReportResponse,
  settleReportResponses,
  type PendingReportResponse,
} from "@t3tools/client-runtime/coordinator-reports";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { CoordinatorReportReference, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "./threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

export const dismissCoordinatorReport =
  createDismissCoordinatorReportCommand(connectionAtomRuntime);

export type PendingResponse = PendingReportResponse<typeof CoordinatorReportReference.Type>;

const NO_RESPONSES: readonly PendingResponse[] = [];

/** Report responses sent from this client that the server does not show yet, by thread key. */
const pendingReportResponsesAtom = Atom.make<ReadonlyMap<string, readonly PendingResponse[]>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("coordinator-reports:pending-responses"));

export const threadReportResponsesAtom = Atom.family((key: string) =>
  Atom.make((get) => get(pendingReportResponsesAtom).get(key) ?? NO_RESPONSES),
);

function updateThreadResponses(
  key: string,
  update: (current: readonly PendingResponse[]) => readonly PendingResponse[],
) {
  appAtomRegistry.update(pendingReportResponsesAtom, (all) => {
    const current = all.get(key) ?? NO_RESPONSES;
    const next = update(current);
    if (next === current) return all;
    const copy = new Map(all);
    if (next.length === 0) copy.delete(key);
    else copy.set(key, next);
    return copy;
  });
}

/**
 * Shows `response` on every surface until the thread's projection has it, the thread is deleted,
 * or the returned function marks it failed. Null when its report already has a response pending.
 */
export function beginReportResponse(
  thread: ScopedThreadRef,
  response: PendingResponse,
): ((error: string) => void) | null {
  const key = threadKey(thread);
  let claimed = false;
  updateThreadResponses(key, (current) => {
    const next = claimReportResponse(current, response);
    claimed = next !== null;
    return next ?? current;
  });
  if (!claimed) return null;
  let stop: (() => void) | undefined;
  let finished = false;
  // The first call runs inside `subscribe`, before `stop` is assigned.
  const finish = () => {
    if (finished) return;
    finished = true;
    queueMicrotask(() => stop?.());
  };
  const stillPending = () =>
    (appAtomRegistry.get(pendingReportResponsesAtom).get(key) ?? NO_RESPONSES).includes(response);
  const threadState = Atom.make((get) => ({
    deleted: get(environmentThreadDetails.statusAtom(thread)) === "deleted",
    projection: Option.getOrNull(get(environmentThreadDetails.stateAtom(thread)).data),
  }));
  stop = appAtomRegistry.subscribe(
    threadState,
    ({ deleted, projection }) => {
      if (deleted) updateThreadResponses(key, () => NO_RESPONSES);
      else if (projection !== null)
        updateThreadResponses(key, (current) =>
          settleReportResponses(current, {
            messageIds: projection.messages.map((message) => message.id),
            dismissals: projection.thread.reportDismissals ?? [],
          }),
        );
      if (!stillPending()) finish();
    },
    { immediate: true },
  );
  return (error) => {
    updateThreadResponses(key, (current) =>
      current.includes(response) ? failReportResponse(current, response.ref, error) : current,
    );
    finish();
  };
}

/**
 * Sends one response to a report and shows it at once. Returns false without sending when the
 * report already has a response pending; a failed send leaves the report open with `failure`.
 */
export async function respondToReport(
  thread: ScopedThreadRef,
  response: PendingResponse,
  send: () => Promise<AtomCommandResult<unknown, unknown>>,
  failure: string,
): Promise<boolean> {
  const fail = beginReportResponse(thread, response);
  if (fail === null) return false;
  const result = await send();
  if (result._tag === "Success") return true;
  const cause = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
  fail(cause instanceof Error ? cause.message : failure);
  return false;
}
