import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  reconcileCompletionSoundSnapshots,
  shouldPlayCompletionSound,
  type CompletionSoundThreadSnapshot,
} from "./completionSound.logic";

const turnId = TurnId.make("turn-1");

describe("shouldPlayCompletionSound", () => {
  it("plays when the same turn changes from running to completed", () => {
    expect(
      shouldPlayCompletionSound(
        { turnId, state: "running", sessionStatus: "running" },
        { turnId, state: "completed", sessionStatus: "ready" },
      ),
    ).toBe(true);
  });

  it("plays when a running latest turn is cleared after the session becomes ready", () => {
    expect(
      shouldPlayCompletionSound(
        { turnId, state: "running", sessionStatus: "running" },
        { turnId: null, state: null, sessionStatus: "ready" },
      ),
    ).toBe(true);
  });

  it("does not play for initial completed state", () => {
    expect(
      shouldPlayCompletionSound(undefined, {
        turnId,
        state: "completed",
        sessionStatus: "ready",
      }),
    ).toBe(false);
  });

  it("does not play when switching to an already completed turn", () => {
    expect(
      shouldPlayCompletionSound(
        { turnId: TurnId.make("turn-previous"), state: "running", sessionStatus: "running" },
        { turnId, state: "completed", sessionStatus: "ready" },
      ),
    ).toBe(false);
  });

  it("does not play for non-completed terminal states", () => {
    expect(
      shouldPlayCompletionSound(
        { turnId, state: "running", sessionStatus: "running" },
        { turnId, state: "error", sessionStatus: "error" },
      ),
    ).toBe(false);
    expect(
      shouldPlayCompletionSound(
        { turnId, state: "running", sessionStatus: "running" },
        { turnId, state: "interrupted", sessionStatus: "interrupted" },
      ),
    ).toBe(false);
  });

  it("does not play when a running latest turn is cleared after an error", () => {
    expect(
      shouldPlayCompletionSound(
        { turnId, state: "running", sessionStatus: "running" },
        { turnId: null, state: null, sessionStatus: "error" },
      ),
    ).toBe(false);
  });
});

describe("reconcileCompletionSoundSnapshots", () => {
  it("returns thread keys that transition from running to completed", () => {
    const previous = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", { turnId, state: "running", sessionStatus: "running" }],
      [
        "environment-a:thread-2",
        { turnId: TurnId.make("turn-2"), state: "running", sessionStatus: "running" },
      ],
    ]);
    const current = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", { turnId, state: "completed", sessionStatus: "ready" }],
      [
        "environment-a:thread-2",
        { turnId: TurnId.make("turn-2"), state: "running", sessionStatus: "running" },
      ],
    ]);

    expect(reconcileCompletionSoundSnapshots(previous, current)).toEqual([
      "environment-a:thread-1",
    ]);
  });

  it("does not report threads that first appear completed", () => {
    const current = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", { turnId, state: "completed", sessionStatus: "ready" }],
    ]);

    expect(reconcileCompletionSoundSnapshots(new Map(), current)).toEqual([]);
  });
});
