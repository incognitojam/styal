import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  REPORT_ANSWER_FAILED,
  reportResponseFailure,
  reportResponsePending,
} from "../reportResponses.ts";
import { threadKey } from "./entities.ts";
import {
  createReportResponses,
  threadReportResponsesAtom,
  type ReportResponseThreadState,
} from "./reportResponses.ts";

it("fails an answer accepted without a commit number once a full sync of the thread lacks it", async () => {
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

  // An older server's success reply carries no commit number to wait for.
  await respond(thread, answer, async () => AsyncResult.success({}));
  expect(reportResponsePending(pending(), answer)).toBe(true);
  registry.set(state, { data: Option.some(projection), status: "live", sequence: 6 });
  expect(reportResponsePending(pending(), answer)).toBe(true);

  // A full sync is the server's whole view; one without the answer means it will not arrive.
  registry.set(state, { data: Option.some(projection), status: "synchronizing", sequence: 6 });
  registry.set(state, { data: Option.some(projection), status: "live", sequence: 7 });
  expect(reportResponsePending(pending(), answer)).toBe(false);
  expect(reportResponseFailure(pending(), ref)?.message).toBe(REPORT_ANSWER_FAILED);
});
