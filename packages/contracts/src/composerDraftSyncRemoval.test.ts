import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2RpcSchemas } from "./orchestrationV2.ts";

const decodeDispatchCommand = Schema.decodeUnknownSync(
  OrchestrationV2RpcSchemas.dispatchCommand.input,
);

// Clients released before composer draft sync was removed attach the draft revision they sent.
describe("composer draft sync removal", () => {
  it("accepts a dispatch from clients that still send a composer draft revision", () => {
    const command = decodeDispatchCommand({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "mobile",
      commandId: "command-older-client",
      threadId: "thread-1",
      messageId: "message-older-client",
      text: "sent from an older client",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      composerDraftRevision: 3,
    });

    expect(command.type).toBe("message.dispatch");
    expect(command).not.toHaveProperty("composerDraftRevision");
  });
});
