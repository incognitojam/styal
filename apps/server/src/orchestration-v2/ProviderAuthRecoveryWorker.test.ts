import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { authRecoveryCommand, type ProviderSignInSignal } from "./ProviderAuthRecoveryWorker.ts";
import type { ProjectionAuthRecoveryCandidate } from "./ProjectionStore.ts";

const STARTED = 1_000;
const FAILED = 2_000;
const NOW = 3_000;
const runId = RunId.make("run-signed-out");
const threadId = ThreadId.make("thread-signed-out");

const candidate = (
  recovery: ProjectionAuthRecoveryCandidate["authRecovery"],
  overrides: Partial<ProjectionAuthRecoveryCandidate> = {},
): ProjectionAuthRecoveryCandidate => ({
  id: threadId,
  archivedAt: null,
  settledOverride: null,
  latestRunId: runId,
  latestRunStartedAt: DateTime.makeUnsafe(STARTED),
  latestRunCompletedAt: DateTime.makeUnsafe(FAILED),
  authRecovery: recovery,
  snoozedUntil: null,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  ...overrides,
});
const waiting = (signedOutSeen: boolean) => ({ runId, waiting: true, signedOutSeen });
const signal = (overrides: Partial<ProviderSignInSignal> = {}): ProviderSignInSignal => ({
  status: "authenticated",
  signedInAtMs: null,
  credentialsChangedAtMs: null,
  ...overrides,
});

describe("authRecoveryCommand", () => {
  it("arms a new failure, recording whether the provider already reads as signed out", () => {
    const command = authRecoveryCommand(
      candidate(null),
      signal({ status: "unauthenticated" }),
      NOW,
    );
    assert.deepInclude(command, {
      type: "thread.metadata.update",
      threadId,
      authRecovery: { runId, waiting: true, signedOutSeen: true },
    });
  });

  it("treats a previous run's recovery as no recovery", () => {
    const stale = { runId: RunId.make("run-earlier"), waiting: true, signedOutSeen: true };
    assert.equal(
      authRecoveryCommand(candidate(stale), signal(), NOW)?.type,
      "thread.metadata.update",
    );
  });

  it("records a signed-out status seen while waiting", () => {
    const command = authRecoveryCommand(
      candidate(waiting(false)),
      signal({ status: "unauthenticated" }),
      NOW,
    );
    assert.deepInclude(command, { authRecovery: { runId, signedOutSeen: true } });
  });

  it.each([
    {
      name: "an in-app sign-in after the run started",
      recovery: false,
      signal: { signedInAtMs: STARTED + 1 },
    },
    {
      name: "a login file rewritten after the failure",
      recovery: false,
      signal: { credentialsChangedAtMs: FAILED + 1 },
    },
    { name: "a provider seen signed out that now reads signed in", recovery: true, signal: {} },
  ])("resumes on $name", (entry) => {
    const command = authRecoveryCommand(
      candidate(waiting(entry.recovery)),
      signal(entry.signal),
      NOW,
    );
    assert.deepInclude(command, {
      type: "message.dispatch",
      threadId,
      authContinuationOfRunId: runId,
      createdBy: "user",
    });
  });

  it.each([
    // The status check can pass while the login is rejected, so reading signed in proves nothing.
    {
      name: "the status never read signed out",
      thread: candidate(waiting(false)),
      signal: signal(),
    },
    {
      name: "the provider is still signed out",
      thread: candidate(waiting(true)),
      signal: signal({ status: "unauthenticated" }),
    },
    {
      name: "the sign-in came before this run started, as when a resumed run fails again",
      thread: candidate(waiting(false)),
      signal: signal({ signedInAtMs: STARTED }),
    },
    {
      // Token refreshes rewrite the file during a healthy run.
      name: "the login file changed before the failure",
      thread: candidate(waiting(false)),
      signal: signal({ credentialsChangedAtMs: FAILED }),
    },
    {
      name: "the user stopped the wait",
      thread: candidate({ ...waiting(true), waiting: false }),
      signal: signal({ signedInAtMs: NOW }),
    },
    {
      name: "the thread is snoozed",
      thread: candidate(waiting(true), { snoozedUntil: DateTime.makeUnsafe(NOW + 1) }),
      signal: signal(),
    },
    {
      name: "the thread is settled",
      thread: candidate(waiting(true), { settledOverride: "settled" }),
      signal: signal(),
    },
    {
      name: "the thread is archived",
      thread: candidate(waiting(true), { archivedAt: DateTime.makeUnsafe(NOW) }),
      signal: signal(),
    },
  ])("does nothing when $name", ({ thread, signal: current }) => {
    assert.isNull(authRecoveryCommand(thread, current, NOW));
  });

  it("derives the same resume command after a restart, so a retried sweep cannot run it twice", () => {
    // In-app sign-in times live in memory, but the saved state and the login file survive.
    const recovery = { ...waiting(false), requestId: CommandId.make("auth-arm") };
    const restarted = signal({ signedInAtMs: null, credentialsChangedAtMs: FAILED + 1 });
    const first = authRecoveryCommand(candidate(recovery), restarted, NOW);
    assert.equal(first?.type, "message.dispatch");
    assert.deepEqual(authRecoveryCommand(candidate(recovery), restarted, NOW + 60_000), first);
    assert.isNull(authRecoveryCommand(candidate(recovery), signal(), NOW));
  });
});
