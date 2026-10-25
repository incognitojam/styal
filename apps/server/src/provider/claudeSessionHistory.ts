import { importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ClaudeSessionHistoryMessage = Schema.Struct({
  type: Schema.Literals(["user", "assistant", "system"]),
  uuid: Schema.String,
  // Saved transcript entries can omit these; default them to the shape the SDK reader returns.
  message: Schema.Unknown.pipe(Schema.withDecodingDefault(Effect.succeed(undefined))),
  parent_tool_use_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  isSidechain: Schema.optionalKey(Schema.Boolean),
  isMeta: Schema.optionalKey(Schema.Boolean),
  teamName: Schema.optionalKey(Schema.String),
});
export type ClaudeSessionHistoryMessage = typeof ClaudeSessionHistoryMessage.Type;

const decodeMessage = Schema.decodeUnknownOption(ClaudeSessionHistoryMessage);

// getSessionMessages follows one parent chain and can omit saved prompts and replies, so read
// the full transcript through the import API for exact rewind. That API is alpha; the native SDK
// regression guards its file-order assumption on SDK upgrades.
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
