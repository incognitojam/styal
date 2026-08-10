import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  reconcileCompletionSoundSnapshots,
  shouldPlayCompletionSound,
  shouldPlayPendingInputSound,
  type CompletionSoundThreadSnapshot,
} from "./completionSound.logic";

const turnId = TurnId.make("turn-1");

function snapshot(
  overrides: Partial<CompletionSoundThreadSnapshot> = {},
): CompletionSoundThreadSnapshot {
  return {
    turnId,
    state: "running",
    sessionStatus: "running",
    hasPendingUserInput: false,
    pendingInputSoundReady: true,
    ...overrides,
  };
}

describe("shouldPlayCompletionSound", () => {
  it("plays when the same turn changes from running to completed", () => {
    expect(
      shouldPlayCompletionSound(
        snapshot(),
        snapshot({ state: "completed", sessionStatus: "ready" }),
      ),
    ).toBe(true);
  });

  it("plays when a running latest turn is cleared after the session becomes ready", () => {
    expect(
      shouldPlayCompletionSound(
        snapshot(),
        snapshot({ turnId: null, state: null, sessionStatus: "ready" }),
      ),
    ).toBe(true);
  });

  it("does not play for initial completed state", () => {
    expect(
      shouldPlayCompletionSound(
        undefined,
        snapshot({ state: "completed", sessionStatus: "ready" }),
      ),
    ).toBe(false);
  });

  it("does not play when switching to an already completed turn", () => {
    expect(
      shouldPlayCompletionSound(
        snapshot({ turnId: TurnId.make("turn-previous") }),
        snapshot({ state: "completed", sessionStatus: "ready" }),
      ),
    ).toBe(false);
  });

  it("does not play for non-completed terminal states", () => {
    expect(
      shouldPlayCompletionSound(snapshot(), snapshot({ state: "error", sessionStatus: "error" })),
    ).toBe(false);
    expect(
      shouldPlayCompletionSound(
        snapshot(),
        snapshot({ state: "interrupted", sessionStatus: "interrupted" }),
      ),
    ).toBe(false);
  });

  it("does not play when a running latest turn is cleared after an error", () => {
    expect(
      shouldPlayCompletionSound(
        snapshot(),
        snapshot({ turnId: null, state: null, sessionStatus: "error" }),
      ),
    ).toBe(false);
  });
});

describe("shouldPlayPendingInputSound", () => {
  it("plays when a synchronized thread starts awaiting user input", () => {
    expect(shouldPlayPendingInputSound(snapshot(), snapshot({ hasPendingUserInput: true }))).toBe(
      true,
    );
  });

  it("does not play when a thread first appears already awaiting input", () => {
    expect(shouldPlayPendingInputSound(undefined, snapshot({ hasPendingUserInput: true }))).toBe(
      false,
    );
  });

  it("does not play while the environment establishes its authoritative baseline", () => {
    expect(
      shouldPlayPendingInputSound(
        snapshot(),
        snapshot({ hasPendingUserInput: true, pendingInputSoundReady: false }),
      ),
    ).toBe(false);
  });

  it("does not play when pending input resolves or remains pending", () => {
    expect(
      shouldPlayPendingInputSound(
        snapshot({ hasPendingUserInput: true }),
        snapshot({ hasPendingUserInput: false }),
      ),
    ).toBe(false);
    expect(
      shouldPlayPendingInputSound(
        snapshot({ hasPendingUserInput: true }),
        snapshot({ hasPendingUserInput: true }),
      ),
    ).toBe(false);
  });

  it("plays again after a previous request resolves", () => {
    const resolved = snapshot({ hasPendingUserInput: false });
    expect(shouldPlayPendingInputSound(resolved, snapshot({ hasPendingUserInput: true }))).toBe(
      true,
    );
  });
});

describe("reconcileCompletionSoundSnapshots", () => {
  it("returns thread keys that transition from running to completed", () => {
    const previous = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", snapshot()],
      ["environment-a:thread-2", snapshot({ turnId: TurnId.make("turn-2") })],
    ]);
    const current = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", snapshot({ state: "completed", sessionStatus: "ready" })],
      ["environment-a:thread-2", snapshot({ turnId: TurnId.make("turn-2") })],
    ]);

    expect(reconcileCompletionSoundSnapshots(previous, current)).toEqual([
      "environment-a:thread-1",
    ]);
  });

  it("does not report threads that first appear completed", () => {
    const current = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", snapshot({ state: "completed", sessionStatus: "ready" })],
    ]);

    expect(reconcileCompletionSoundSnapshots(new Map(), current)).toEqual([]);
  });

  it("returns a thread key when it starts awaiting user input", () => {
    const previous = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", snapshot()],
    ]);
    const current = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", snapshot({ hasPendingUserInput: true })],
    ]);

    expect(reconcileCompletionSoundSnapshots(previous, current)).toEqual([
      "environment-a:thread-1",
    ]);
  });

  it("returns a thread key only once when completion and pending input arrive together", () => {
    const previous = new Map<string, CompletionSoundThreadSnapshot>([
      ["environment-a:thread-1", snapshot()],
    ]);
    const current = new Map<string, CompletionSoundThreadSnapshot>([
      [
        "environment-a:thread-1",
        snapshot({
          state: "completed",
          sessionStatus: "ready",
          hasPendingUserInput: true,
        }),
      ],
    ]);

    expect(reconcileCompletionSoundSnapshots(previous, current)).toEqual([
      "environment-a:thread-1",
    ]);
  });
});
