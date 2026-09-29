import { describe, expect, it } from "vite-plus/test";

import { resolveThreadDisplayTimestamp } from "./thread-timestamp.ts";

describe("resolveThreadDisplayTimestamp", () => {
  const olderServerThread = {
    createdAt: "2026-09-29T15:00:00.000Z",
    latestUserMessageAt: "2026-09-29T15:25:00.000Z",
    updatedAt: "2026-09-29T15:50:00.000Z",
  };

  it("uses thread activity for Last message when an older server omits the message timestamp", () => {
    expect(resolveThreadDisplayTimestamp(olderServerThread, "last_prompted")).toBe(
      olderServerThread.latestUserMessageAt,
    );
    expect(resolveThreadDisplayTimestamp(olderServerThread, "last_message")).toBe(
      olderServerThread.updatedAt,
    );
    expect(
      resolveThreadDisplayTimestamp(
        { ...olderServerThread, latestMessageAt: null },
        "last_message",
      ),
    ).toBe(olderServerThread.updatedAt);
  });

  it("uses the precise message timestamp when the server provides it", () => {
    const thread = { ...olderServerThread, latestMessageAt: "2026-09-29T15:42:00.000Z" };
    expect(resolveThreadDisplayTimestamp(thread, "last_message")).toBe(thread.latestMessageAt);
  });
});
