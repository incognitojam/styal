import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  REPORT_ANSWER_FAILED,
  REPORT_REPLY_FAILED,
  reportResponseFailure,
  reportResponsePending,
} from "../reportResponses.ts";
import { threadKey } from "./entities.ts";
import {
  createReportResponses,
  pendingReportResponsesAtom,
  threadReportResponsesAtom,
  withPendingReportResponses,
  type ReportResponseThreadState,
} from "./reportResponses.ts";

it("waits for a full sync to judge an interrupted send, and fails only that answer", async () => {
  const registry = AtomRegistry.make();
  const projection = { messages: [], thread: {} } as unknown as Option.Option.Value<
    ReportResponseThreadState["data"]
  >;
  const state = Atom.make<ReportResponseThreadState>({
    data: Option.some(projection),
    status: "live",
    sequence: 5,
  });
  const { respond } = createReportResponses(registry, { stateAtom: () => state });
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

  // Another report's answer, acknowledged with a commit the sync below has not reached yet.
  const otherRef = { messageId: MessageId.make("other-report"), key: "fence", version: 1 };
  const other = { ...answer, ref: otherRef, messageId: MessageId.make("other-answer") };
  await respond(thread, other, async () => AsyncResult.success({ sequence: 9 }));

  // A full sync is the server's whole view; one without the answer means it did not arrive.
  registry.set(state, { data: Option.some(projection), status: "synchronizing", sequence: 6 });
  registry.set(state, { data: Option.some(projection), status: "live", sequence: 7 });
  expect(reportResponsePending(pending(), answer)).toBe(false);
  expect(reportResponseFailure(pending(), ref)?.message).toBe(REPORT_ANSWER_FAILED);
  expect(reportResponsePending(pending(), other)).toBe(true);
});

it("forgets a failed response once its report is no longer open", async () => {
  const registry = AtomRegistry.make();
  const ref = { messageId: MessageId.make("report"), key: "shed", version: 1 };
  const projection = (messages: ReadonlyArray<object>) =>
    ({ messages, thread: {} }) as unknown as Option.Option.Value<ReportResponseThreadState["data"]>;
  const state = Atom.make<ReportResponseThreadState>({
    data: Option.some(projection([])),
    status: "live",
    sequence: 5,
  });
  const { respond } = createReportResponses(registry, { stateAtom: () => state });
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const reply = {
    ref,
    kind: "answer" as const,
    reply: true,
    messageId: MessageId.make("answer"),
    text: "[Shed, version 1] Next week",
    createdAt: "2026-11-19T10:00:00.000Z",
  };
  await respond(thread, reply, async () => AsyncResult.failure(Cause.fail(new Error("Offline"))));
  expect(
    reportResponseFailure(
      registry.get(pendingReportResponsesAtom).get(threadKey(thread)) ?? [],
      ref,
    ),
  ).toEqual({
    message: REPORT_REPLY_FAILED,
    detail: "Offline",
  });
  // Failed responses no longer lower a thread's count.
  const shells = [{ id: thread.threadId, openReportQuestionCount: 1 }] as never;
  expect(
    withPendingReportResponses(
      thread.environmentId,
      shells,
      registry.get(pendingReportResponsesAtom),
    ),
  ).toBe(shells);

  // Answered from another client: the failure has nothing left to say.
  registry.set(state, {
    data: Option.some(
      projection([{ id: MessageId.make("elsewhere"), role: "user", reportAnswer: ref }]),
    ),
    status: "live",
    sequence: 6,
  });
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
  const { respond } = createReportResponses(registry, { stateAtom: () => state });
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
