import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./thread-outbox-model";

describe("thread outbox after composer draft sync removal", () => {
  it("decodes messages queued by app versions that synchronized drafts", () => {
    const message: QueuedThreadMessage = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("message-1"),
      commandId: CommandId.make("command-message-1"),
      text: "queued before upgrading",
      attachments: [],
      runtimeMode: "approval-required",
      createdAt: "2026-06-08T10:00:01.000Z",
    };
    // Those versions wrote schema version 4 and attached the draft revision they sent.
    const stored = {
      ...(encodeQueuedThreadMessage(message) as object),
      schemaVersion: 4,
      composerDraftRevision: 7,
    };

    expect(decodeQueuedThreadMessage(stored)).toEqual(message);
  });
});
