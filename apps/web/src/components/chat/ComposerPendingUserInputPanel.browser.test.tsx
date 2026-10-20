import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const url = "https://accounts.example.com/device?user_code=RTJS-TQGS";
const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: `Authorize the device at ${url} and confirm.`,
      options: [{ label: "Done", description: "The device is authorized" }],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

it("links URLs in the question text", async () => {
  await using screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      cwd="/repo"
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );

  const links = [...screen.container.querySelectorAll("a")].map((anchor) =>
    anchor.getAttribute("href"),
  );
  expect(links).toContain(url);
});
