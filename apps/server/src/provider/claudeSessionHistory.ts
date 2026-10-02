import * as NodeUtil from "node:util";

import { importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ClaudeSessionHistoryMessage = Schema.Struct({
  type: Schema.Literals(["user", "assistant", "system"]),
  uuid: Schema.String,
  message: Schema.optionalKey(Schema.Unknown),
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isSidechain: Schema.optionalKey(Schema.Boolean),
  isMeta: Schema.optionalKey(Schema.Boolean),
  teamName: Schema.optionalKey(Schema.String),
  forkedFrom: Schema.optionalKey(
    Schema.Struct({ sessionId: Schema.String, messageUuid: Schema.String }),
  ),
});
type ClaudeSessionHistoryMessage = typeof ClaudeSessionHistoryMessage.Type;

const decodeMessage = Schema.decodeUnknownOption(ClaudeSessionHistoryMessage);

// getSessionMessages reconstructs one parent chain and can omit saved prompts
// and replies. The SDK's import API reads the full transcript without guessing
// its path; collect only main-session messages, in memory, for exact rewind.
// The import API is alpha; the native SDK regression guards its file-order and
// fork-provenance assumptions when upgrading the SDK.
export async function readClaudeSessionHistory(sessionId: string, options: { dir?: string }) {
  const messages: Array<ClaudeSessionHistoryMessage> = [];
  await importSessionToStore(
    sessionId,
    {
      append: async (_key, entries) => {
        for (const entry of entries) {
          const decoded = decodeMessage(entry);
          if (Option.isNone(decoded)) continue;
          const message = decoded.value;
          if (!message.isSidechain && !message.isMeta && !message.teamName) messages.push(message);
        }
      },
      load: async () => null,
    },
    { ...options, includeSubagents: false },
  );
  return messages;
}

export function remapClaudeForkTurnBoundaries(
  sessionId: string,
  retainedMessages: ReadonlyArray<ClaudeSessionHistoryMessage>,
  forkMessages: ReadonlyArray<ClaudeSessionHistoryMessage>,
  retainedBoundaries: ReadonlyArray<string | null>,
): Array<string> | undefined {
  const conversation = retainedMessages.filter((message) => message.type !== "system");
  const forkConversation = forkMessages.filter((message) => message.type !== "system");
  // Fork provenance is stable even when the history reader changes its chain,
  // UUIDs are rewritten, or identical prompts occur more than once.
  if (conversation.length !== forkConversation.length) return undefined;
  const forkIds = new Map<string, string>();
  for (const [index, message] of conversation.entries()) {
    const forkMessage = forkConversation[index];
    if (
      forkMessage?.forkedFrom?.sessionId !== sessionId ||
      forkMessage.forkedFrom.messageUuid !== message.uuid ||
      forkMessage.type !== message.type ||
      !NodeUtil.isDeepStrictEqual(forkMessage.message, message.message)
    ) {
      return undefined;
    }
    forkIds.set(message.uuid, forkMessage.uuid);
  }
  const remapped: Array<string> = [];
  for (const id of retainedBoundaries) {
    const forkId = id === null ? undefined : forkIds.get(id);
    if (forkId === undefined) return undefined;
    remapped.push(forkId);
  }
  return remapped;
}
