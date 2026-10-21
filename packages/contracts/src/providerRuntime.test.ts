import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("decodes sanitized command interactions", () => {
    const parsed = decodeRuntimeEvent({
      type: "command.interaction",
      eventId: "event-command-interaction",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "exec-1",
      payload: {
        interaction: "ctrl_c",
      },
    });

    expect(parsed.type).toBe("command.interaction");
    if (parsed.type !== "command.interaction") {
      throw new Error("expected command.interaction");
    }
    expect(parsed.payload).toEqual({ interaction: "ctrl_c" });
  });
});
