import * as NodeUtil from "node:util";
import type { ClaudeSessionHistoryMessage } from "../../provider/claudeSessionHistory.ts";

const isClaudeConversationMessage = (message: ClaudeSessionHistoryMessage): boolean =>
  message.type === "user" || message.type === "assistant";

export const isClaudeHumanTurnStart = (message: ClaudeSessionHistoryMessage): boolean => {
  if (message.type !== "user" || message.parent_tool_use_id !== null) return false;
  const body = message.message;
  if (typeof body !== "object" || body === null || !("content" in body)) return false;
  const content = body.content;
  return (
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.some(
        (part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type !== "tool_result",
      ))
  );
};

const conversationIndexForUuid = (
  messages: ReadonlyArray<ClaudeSessionHistoryMessage>,
  uuid: string,
): number => {
  let index = -1;
  for (const message of messages) {
    if (!isClaudeConversationMessage(message)) continue;
    index += 1;
    if (message.uuid === uuid) return index;
  }
  return -1;
};

// Native forks rewrite every UUID. getSessionMessages then rebuilds the
// parentUuid chain, so system notices and compact metadata can change the
// raw length without dropping retained user/assistant turns. Align those
// conversation messages from the truncated end, then remap T3 turn starts.
export const remapClaudeForkTurnBoundaries = (
  messages: ReadonlyArray<ClaudeSessionHistoryMessage>,
  forkMessages: ReadonlyArray<ClaudeSessionHistoryMessage>,
  firstRemoved: number,
  retainedBoundaries: ReadonlyArray<string | null>,
): Array<string | null> | undefined => {
  const retainedConversation = messages.slice(0, firstRemoved).filter(isClaudeConversationMessage);
  const forkConversation = forkMessages.filter(isClaudeConversationMessage);
  if (retainedConversation.length === 0) {
    return retainedBoundaries.every((id) => id === null) ? [...retainedBoundaries] : undefined;
  }
  const offset = forkConversation.length - retainedConversation.length;
  // Forks preserve message bodies. Matching roles alone can mistake a restored
  // steering message for a retained turn when compaction changes the chain.
  if (
    offset < 0 ||
    retainedConversation.some((message, index) => {
      const forkMessage = forkConversation[index + offset];
      return (
        forkMessage === undefined ||
        forkMessage.type !== message.type ||
        !NodeUtil.isDeepStrictEqual(forkMessage.message, message.message)
      );
    })
  ) {
    return undefined;
  }
  const remapped = retainedBoundaries.map((originalId) => {
    if (originalId === null) return null;
    const originalIndex = conversationIndexForUuid(messages, originalId);
    const forkIndex = originalIndex + offset;
    const forkMessage =
      originalIndex >= 0 && forkIndex >= 0 ? forkConversation[forkIndex] : undefined;
    const originalMessage = messages.find((message) => message.uuid === originalId);
    return forkMessage !== undefined &&
      originalMessage !== undefined &&
      forkMessage.type === originalMessage.type
      ? forkMessage.uuid
      : null;
  });
  // Unknown older boundaries stay unknown; every known boundary must remap.
  return remapped.some((id, index) => id === null && retainedBoundaries[index] !== null)
    ? undefined
    : remapped;
};
