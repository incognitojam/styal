import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { reportResponsePending } from "../reportResponses.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { threadKey } from "./entities.ts";
import {
  createReportResponses,
  pendingReportResponsesAtom,
  threadReportResponsesAtom,
  withPendingReportResponses,
  type ReportResponse,
  type ReportResponseThreadState,
} from "./reportResponses.ts";

const store = (
  registry: AtomRegistry.AtomRegistry,
  state: Atom.Atom<ReportResponseThreadState>,
  list = Atom.make<{ readonly snapshotSequence: number } | null>(null),
) => {
  const failed: Array<readonly [string, string | undefined]> = [];
  const responses = createReportResponses(registry, {
    stateAtom: () => state,
    snapshotAtom: () => list,
    onFailed: (_thread: unknown, response: ReportResponse, detail?: string) =>
      failed.push([response.kind === "answer" ? response.messageId : "dismiss", detail]),
  });
  return { ...responses, failed };
};

it("waits for a full sync to judge an interrupted send, and fails only the unconfirmed ones", async () => {
  const registry = AtomRegistry.make();
  const projection = { messages: [], thread: {} } as unknown as Option.Option.Value<
    ReportResponseThreadState["data"]
  >;
  const state = Atom.make<ReportResponseThreadState>({
    data: Option.some(projection),
    status: "live",
    sequence: 5,
  });
  const { respond, failed } = store(registry, state);
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const ref = { messageId: MessageId.make("report"), key: "shed", version: 1 };
  const answer = {
    ref,
    kind: "answer" as const,
    messageId: MessageId.make("answer"),
    text: "[Shed, version 1] Start it",
    createdAt: "2026-11-19T10:00:00.000Z",
  };
  const pending = () => registry.get(threadReportResponsesAtom(threadKey(thread)));

  // The server may have the answer, so it stays given and a second one is refused.
  await respond(thread, answer, async () => AsyncResult.failure(Cause.interrupt()));
  expect(reportResponsePending(pending(), answer)).toBe(true);
  expect(
    await respond(thread, { ...answer, messageId: MessageId.make("again") }, async () =>
      AsyncResult.success({ sequence: 6 }),
    ),
  ).toBe(false);
  registry.set(state, { data: Option.some(projection), status: "live", sequence: 6 });
  expect(reportResponsePending(pending(), answer)).toBe(true);

  // So is a send whose connection dropped before the reply came back.
  const lostRef = { messageId: MessageId.make("lost-report"), key: "gate", version: 1 };
  const lost = { ...answer, ref: lostRef, messageId: MessageId.make("lost-answer") };
  await respond(thread, lost, async () =>
    AsyncResult.failure(
      Cause.fail(
        new EnvironmentRpcUnavailableError({
          environmentId: "env",
          message: "The connection was lost.",
          outcomeUnknown: true,
        }),
      ),
    ),
  );
  expect(reportResponsePending(pending(), lost)).toBe(true);

  // Another report's answer, acknowledged with a commit the sync below has not reached yet.
  const otherRef = { messageId: MessageId.make("other-report"), key: "fence", version: 1 };
  const other = { ...answer, ref: otherRef, messageId: MessageId.make("other-answer") };
  await respond(thread, other, async () => AsyncResult.success({ sequence: 9 }));

  // A full sync is the server's whole view; one without the answer means it did not arrive.
  registry.set(state, { data: Option.some(projection), status: "synchronizing", sequence: 6 });
  registry.set(state, { data: Option.some(projection), status: "live", sequence: 7 });
  expect(reportResponsePending(pending(), answer)).toBe(false);
  expect(reportResponsePending(pending(), lost)).toBe(false);
  expect(failed).toEqual([
    ["answer", "The server did not receive it."],
    ["lost-answer", "The server did not receive it."],
  ]);
  expect(reportResponsePending(pending(), other)).toBe(true);
});

it("drops a refused reply at once and stops lowering the count", async () => {
  const registry = AtomRegistry.make();
  const ref = { messageId: MessageId.make("report"), key: "shed", version: 1 };
  const state = Atom.make<ReportResponseThreadState>({
    data: Option.some({ messages: [], thread: {} } as unknown as Option.Option.Value<
      ReportResponseThreadState["data"]
    >),
    status: "live",
    sequence: 5,
  });
  const { respond, failed } = store(registry, state);
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const shells = [{ id: thread.threadId, openReportQuestionCount: 1 }] as never;
  let lowered: unknown;
  await respond(
    thread,
    {
      ref,
      kind: "answer",
      reply: "Next week",
      messageId: MessageId.make("answer"),
      text: "[Shed, version 1] Next week",
      createdAt: "2026-11-19T10:00:00.000Z",
    },
    async () => {
      lowered = withPendingReportResponses(
        thread.environmentId,
        shells,
        registry.get(pendingReportResponsesAtom),
      );
      return AsyncResult.failure(Cause.fail(new Error("Offline")));
    },
  );
  expect(lowered).toEqual([
    { id: thread.threadId, openReportQuestionCount: 0, latestOpenReportQuestionAt: null },
  ]);
  expect(failed).toEqual([["answer", "Offline"]]);
  expect(registry.get(pendingReportResponsesAtom).size).toBe(0);
  expect(
    withPendingReportResponses(
      thread.environmentId,
      shells,
      registry.get(pendingReportResponsesAtom),
    ),
  ).toBe(shells);
});

it("keeps lowering the count until the thread list catches up with the thread", async () => {
  const registry = AtomRegistry.make();
  const ref = { messageId: MessageId.make("report"), key: "shed", version: 1 };
  const projection = (messages: ReadonlyArray<object>) =>
    ({ messages, thread: {} }) as unknown as Option.Option.Value<ReportResponseThreadState["data"]>;
  const state = Atom.make<ReportResponseThreadState>({
    data: Option.some(projection([])),
    status: "live",
    sequence: 5,
  });
  const list = Atom.make<{ readonly snapshotSequence: number } | null>({ snapshotSequence: 5 });
  const { respond, begin } = store(registry, state, list);
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const shells = [{ id: thread.threadId, openReportQuestionCount: 1 }] as never;
  const count = () =>
    withPendingReportResponses(
      thread.environmentId,
      shells,
      registry.get(pendingReportResponsesAtom),
      registry.get(list)?.snapshotSequence,
    )[0]?.openReportQuestionCount;
  await respond(
    thread,
    {
      ref,
      kind: "answer",
      messageId: MessageId.make("answer"),
      text: "[Shed, version 1] Start it",
      createdAt: "2026-11-19T10:00:00.000Z",
    },
    async () => AsyncResult.success({ sequence: 6 }),
  );
  // The thread shows the answer before the thread list, which still counts the question.
  registry.set(state, {
    data: Option.some(
      projection([{ id: MessageId.make("answer"), role: "user", reportAnswer: ref }]),
    ),
    status: "live",
    sequence: 6,
  });
  expect(count()).toBe(0);
  registry.set(list, { snapshotSequence: 6 });
  expect(registry.get(pendingReportResponsesAtom).size).toBe(0);

  // Shown at a later sequence before the send's own acknowledgement comes back.
  const laterRef = { ...ref, version: 2 };
  const handle = begin(thread, {
    ref: laterRef,
    kind: "answer",
    messageId: MessageId.make("later"),
    text: "[Shed, version 2] Start it",
    createdAt: "2026-11-19T10:01:00.000Z",
  });
  registry.set(state, {
    data: Option.some(
      projection([{ id: MessageId.make("later"), role: "user", reportAnswer: laterRef }]),
    ),
    status: "live",
    sequence: 9,
  });
  registry.set(list, { snapshotSequence: 7 });
  expect(registry.get(pendingReportResponsesAtom).size).toBe(1);
  handle?.settle(AsyncResult.success({ sequence: 7 }));
  expect(registry.get(pendingReportResponsesAtom).size).toBe(0);
});

it("refuses a response to a report the thread already shows answered", async () => {
  const registry = AtomRegistry.make();
  const ref = { messageId: MessageId.make("report"), key: "shed", version: 1 };
  const projection = {
    messages: [
      {
        id: ref.messageId,
        role: "assistant",
        text: "Report",
        report: {
          key: "shed",
          title: "Shed",
          version: 1,
          question: "Start?",
          answers: ["Start it"],
        },
      },
      { id: MessageId.make("first"), role: "user", text: "Start it", reportAnswer: ref },
      // A newer version replaces it on screen; the answer to version 1 still stands.
      {
        id: MessageId.make("report-2"),
        role: "assistant",
        text: "Report",
        report: {
          key: "shed",
          title: "Shed",
          version: 2,
          question: "Start?",
          answers: ["Start it"],
        },
      },
    ],
    thread: {},
  } as unknown as Option.Option.Value<ReportResponseThreadState["data"]>;
  const state = Atom.make<ReportResponseThreadState>({
    data: Option.some(projection),
    status: "live",
    sequence: 5,
  });
  const { respond } = store(registry, state);
  let sent = 0;
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  // A screen that has fallen behind can still offer the buttons; the store knows better.
  const accepted = await respond(
    thread,
    {
      ref,
      kind: "answer",
      messageId: MessageId.make("second"),
      text: "[Shed, version 1] Start it",
      createdAt: "2026-11-19T10:00:00.000Z",
    },
    async () => {
      sent += 1;
      return AsyncResult.success({ sequence: 6 });
    },
  );
  expect(accepted).toBe(false);
  expect(sent).toBe(0);
});

it("drops a response that fails before it is sent", () => {
  const registry = AtomRegistry.make();
  const ref = { messageId: MessageId.make("report"), key: "shed", version: 1 };
  const projection = { messages: [], thread: {} } as unknown as Option.Option.Value<
    ReportResponseThreadState["data"]
  >;
  const state = Atom.make<ReportResponseThreadState>({
    data: Option.some(projection),
    status: "live",
    sequence: 5,
  });
  const { begin, failed } = store(registry, state);
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const handle = begin(thread, {
    ref,
    kind: "answer",
    messageId: MessageId.make("answer"),
    text: "[Shed, version 1] Start it",
    createdAt: "2026-11-19T10:00:00.000Z",
  });
  handle?.fail("Attachments could not upload");
  expect(registry.get(pendingReportResponsesAtom).size).toBe(0);
  expect(failed).toEqual([["answer", "Attachments could not upload"]]);
});
