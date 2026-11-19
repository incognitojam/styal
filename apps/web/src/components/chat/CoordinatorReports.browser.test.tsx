import { createReportResponses } from "@t3tools/client-runtime/state/report-responses";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { CoordinatorReportsContext, ReportAnswerBar, type ReportState } from "./CoordinatorReports";

it("sends one answer when an offered answer is clicked twice before the server confirms", async () => {
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const threadState = Atom.make({ data: Option.none(), status: "live" as const, sequence: 0 });
  const { respond } = createReportResponses(AtomRegistry.make(), { stateAtom: () => threadState });
  let confirm = () => {};
  const send = vi.fn(
    () =>
      new Promise<AsyncResult.Success<{ readonly sequence: number }, never>>((resolve) => {
        confirm = () => resolve(AsyncResult.success({ sequence: 1 }));
      }),
  );
  const message = {
    id: MessageId.make("report"),
    role: "assistant" as const,
    text: "Report",
    createdAt: "2026-11-19T10:00:00.000Z",
    report: { key: "shed", title: "Shed", version: 1, question: "Start?", answers: ["Start it"] },
  };
  const report: ReportState = { message, latest: message, state: "open", answer: undefined };
  await using screen = await render(
    <CoordinatorReportsContext
      value={{
        reports: [report],
        answers: new Map(),
        responses: [],
        delivery: { sending: [], queued: [] },
        answer: (text, ref) =>
          void respond(
            thread,
            {
              ref,
              kind: "answer",
              messageId: MessageId.make(`answer-${send.mock.calls.length}`),
              text,
              createdAt: "2026-11-19T10:01:00.000Z",
            },
            send,
          ),
        reply: () => {},
        dismiss: () => {},
        scroll: () => {},
        canOperate: true,
        target: null,
        clear: () => {},
      }}
    >
      <ReportAnswerBar report={report} renderAnswer={() => null} />
    </CoordinatorReportsContext>,
  );
  const answer = screen.getByRole("button", { name: /^Start it/ });
  await answer.click();
  await answer.click();
  confirm();
  expect(send).toHaveBeenCalledTimes(1);
});
