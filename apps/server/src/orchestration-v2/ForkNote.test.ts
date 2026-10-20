import { assert, describe, it } from "@effect/vitest";

import { shouldSendForkNote } from "./ForkNote.ts";

const fork = { type: "fork" as const, targetThreadId: "fork-thread" };

const state = (input: {
  readonly runs: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly attempts: ReadonlyArray<{
    readonly id: string;
    readonly runId: string;
    readonly accepted: boolean;
  }>;
  readonly starting: { readonly runId: string; readonly attemptId: string };
  readonly transfers?: ReadonlyArray<typeof fork>;
}) => ({
  threadId: "fork-thread",
  run: { userMessageId: `message-${input.starting.runId}` },
  attemptId: input.starting.attemptId,
  runs: input.runs.map((run) => ({ id: run.id, userMessageId: `message-${run.id}` })),
  attempts: input.attempts.map(({ id, runId }) => ({ id, runId })),
  providerTurns: input.attempts
    .filter((attempt) => attempt.accepted)
    .map((attempt) => ({ runAttemptId: attempt.id })),
  messages: input.runs.map((run) => ({ id: `message-${run.id}`, text: run.text })),
  contextTransfers: input.transfers ?? [fork],
});

describe("shouldSendForkNote", () => {
  it("sends the note with a fork's first turn", () => {
    assert.isTrue(
      shouldSendForkNote(
        state({
          runs: [{ id: "run-1", text: "Carry on" }],
          attempts: [{ id: "attempt-1", runId: "run-1", accepted: false }],
          starting: { runId: "run-1", attemptId: "attempt-1" },
        }),
      ),
    );
  });

  it("does not send the note on a thread that is not a fork", () => {
    assert.isFalse(
      shouldSendForkNote(
        state({
          runs: [{ id: "run-1", text: "Carry on" }],
          attempts: [{ id: "attempt-1", runId: "run-1", accepted: false }],
          starting: { runId: "run-1", attemptId: "attempt-1" },
          transfers: [],
        }),
      ),
    );
  });

  it("does not repeat the note after a turn has delivered it", () => {
    assert.isFalse(
      shouldSendForkNote(
        state({
          runs: [
            { id: "run-1", text: "Carry on" },
            { id: "run-2", text: "And then?" },
          ],
          attempts: [
            { id: "attempt-1", runId: "run-1", accepted: true },
            { id: "attempt-2", runId: "run-2", accepted: false },
          ],
          starting: { runId: "run-2", attemptId: "attempt-2" },
        }),
      ),
    );
  });

  it("sends the note on the next run when the first run never reached the provider", () => {
    assert.isTrue(
      shouldSendForkNote(
        state({
          runs: [
            { id: "run-1", text: "Carry on" },
            { id: "run-2", text: "Try again" },
          ],
          attempts: [
            { id: "attempt-1", runId: "run-1", accepted: false },
            { id: "attempt-2", runId: "run-2", accepted: false },
          ],
          starting: { runId: "run-2", attemptId: "attempt-2" },
        }),
      ),
    );
  });

  it("does not repeat the note when a steer replaces an accepted attempt of the same run", () => {
    assert.isFalse(
      shouldSendForkNote(
        state({
          runs: [{ id: "run-1", text: "Actually, do this instead" }],
          attempts: [
            { id: "attempt-1", runId: "run-1", accepted: true },
            { id: "attempt-2", runId: "run-1", accepted: false },
          ],
          starting: { runId: "run-1", attemptId: "attempt-2" },
        }),
      ),
    );
  });

  it("leaves provider commands unprefixed and sends the note with the next turn", () => {
    const first = state({
      runs: [{ id: "run-1", text: "/goal implement the fix" }],
      attempts: [{ id: "attempt-1", runId: "run-1", accepted: false }],
      starting: { runId: "run-1", attemptId: "attempt-1" },
    });
    assert.isFalse(shouldSendForkNote(first));
    assert.isTrue(
      shouldSendForkNote(
        state({
          runs: [
            { id: "run-1", text: "/goal implement the fix" },
            { id: "run-2", text: "How is it going?" },
          ],
          attempts: [
            { id: "attempt-1", runId: "run-1", accepted: true },
            { id: "attempt-2", runId: "run-2", accepted: false },
          ],
          starting: { runId: "run-2", attemptId: "attempt-2" },
        }),
      ),
    );
  });
});
