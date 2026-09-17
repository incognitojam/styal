import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { summarizeHostSessions } from "./HostActivity.ts";

const thread = (id: string) => ({
  id: ThreadId.make(id),
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
});

describe("host session activity", () => {
  it("does not count open idle sessions as running work", () => {
    expect(
      summarizeHostSessions(
        [thread("idle")],
        [{ threadId: ThreadId.make("idle"), status: "ready" }],
      ),
    ).toEqual({ activeSessions: 0, waitingSessions: 0 });
  });
  it("includes every provider and deduplicates runtime and projected activity", () => {
    const id = ThreadId.make("remote-thread");
    expect(
      summarizeHostSessions(
        [{ ...thread(id), backgroundLiveness: "working" }],
        [
          { threadId: id, status: "running" },
          { threadId: ThreadId.make("connecting"), status: "connecting" },
          {
            threadId: ThreadId.make("active-turn"),
            status: "ready",
            activeTurnId: TurnId.make("turn"),
          },
        ],
      ),
    ).toEqual({ activeSessions: 3, waitingSessions: 0 });
  });
  it("counts approval/input waits once and preserves background monitoring", () => {
    expect(
      summarizeHostSessions(
        [
          { ...thread("approval"), hasPendingApprovals: true, hasPendingUserInput: true },
          { ...thread("input"), hasPendingUserInput: true },
          { ...thread("monitor"), backgroundLiveness: "monitoring" },
        ],
        [{ threadId: ThreadId.make("approval"), status: "running" }],
      ),
    ).toEqual({ activeSessions: 1, waitingSessions: 2 });
  });
  it("protects a dispatched turn before the provider has started it", () => {
    expect(
      summarizeHostSessions(
        [
          {
            ...thread("queued"),
            latestTurn: {
              turnId: TurnId.make("turn"),
              state: "running",
              requestedAt: "2026-01-01T00:00:00.000Z",
              startedAt: null,
              completedAt: null,
              assistantMessageId: null,
            },
          },
        ],
        [],
      ),
    ).toEqual({ activeSessions: 1, waitingSessions: 0 });
  });
});
