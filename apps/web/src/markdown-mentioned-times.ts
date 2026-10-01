/**
 * Marks the times a message mentions (`14:20 UTC`, `49 minutes ago`) so the renderer can show
 * them as chips that explain the moment in the reader's own time zone. The text stays as written;
 * the parsed time rides along on the element and is resolved at render time.
 *
 * Code and link labels are left alone: a time inside either belongs to something else.
 */
import {
  findMentionedTimes,
  findMessageZone,
  type MentionedTime,
  type MentionedTimeZone,
} from "@t3tools/client-runtime/mentioned-times";

interface MarkdownAstNode {
  type?: string;
  value?: unknown;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

/** The hast property carrying a mentioned time, as the renderer reads it back. */
export const MENTIONED_TIME_PROPERTY = "dataMentionedTime";

function mentionedTimeNode(value: string, time: MentionedTime): MarkdownAstNode {
  return {
    type: "mentionedTime",
    children: [{ type: "text", value }],
    data: { hName: "span", hProperties: { [MENTIONED_TIME_PROPERTY]: JSON.stringify(time) } },
  };
}

function splitTextNode(
  value: string,
  messageZone: MentionedTimeZone | null,
  before: string,
): MarkdownAstNode[] | null {
  const matches = findMentionedTimes(value, { messageZone, before });
  if (matches.length === 0) return null;
  const nodes: MarkdownAstNode[] = [];
  let consumed = 0;
  for (const match of matches) {
    if (match.start > consumed) {
      nodes.push({ type: "text", value: value.slice(consumed, match.start) });
    }
    nodes.push(mentionedTimeNode(value.slice(match.start, match.end), match.time));
    consumed = match.end;
  }
  if (consumed < value.length) nodes.push({ type: "text", value: value.slice(consumed) });
  return nodes;
}

/** The message's prose, where marking happens: text outside code and link labels. */
function proseOf(node: MarkdownAstNode, parts: string[] = []): string[] {
  if (node.type === "link" || node.type === "linkReference") return parts;
  if (node.type === "text" && typeof node.value === "string") parts.push(node.value);
  for (const child of node.children ?? []) proseOf(child, parts);
  return parts;
}

/** Formatting inside a sentence; any other node starts a new run of text. */
const INLINE_TYPES = new Set(["text", "emphasis", "strong", "delete", "inlineCode", "break"]);

export function remarkMentionedTimes() {
  return (tree: MarkdownAstNode) => {
    const messageZone = findMessageZone(proseOf(tree).join("\n"));
    // The same block's text so far, so "merged at **14:39 UTC**" still reads as past.
    let before = "";
    const visit = (node: MarkdownAstNode): void => {
      if (!INLINE_TYPES.has(node.type ?? "")) before = "";
      if (node.type === "link" || node.type === "linkReference") return;
      const children = node.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (!child) continue;
        if (child.type === "inlineCode") before += " ";
        if (child.type === "text" && typeof child.value === "string") {
          const replacement = splitTextNode(child.value, messageZone, before);
          before += child.value;
          if (replacement) {
            children.splice(index, 1, ...replacement);
            index += replacement.length - 1;
          }
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

function isWholeNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The time a rendered element carries. Raw HTML in a message can spell the same attribute, so
 * anything that does not have the shape the plugin writes is ignored.
 */
export function readMentionedTime(encoded: unknown): MentionedTime | null {
  if (typeof encoded !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const time = value as Record<string, unknown>;
  if (time.kind === "offset") {
    return typeof time.milliseconds === "number" && Number.isFinite(time.milliseconds)
      ? { kind: "offset", milliseconds: time.milliseconds }
      : null;
  }
  if (time.kind !== "clock") return null;
  if (!isWholeNumber(time.hour, 0, 23) || !isWholeNumber(time.minute, 0, 59)) return null;
  if (time.second !== undefined && !isWholeNumber(time.second, 0, 59)) return null;
  if (time.weekday !== undefined && !isWholeNumber(time.weekday, 0, 6)) return null;
  if (time.dayOffset !== undefined && !isWholeNumber(time.dayOffset, -1, 1)) return null;
  if (time.tense !== undefined && time.tense !== "past" && time.tense !== "future") return null;
  if (time.zoneFromMessage !== undefined && typeof time.zoneFromMessage !== "boolean") return null;
  if (time.date !== undefined) {
    const date = time.date as Record<string, unknown> | null;
    if (typeof date !== "object" || date === null) return null;
    if (!isWholeNumber(date.month, 1, 12) || !isWholeNumber(date.day, 1, 31)) return null;
    if (date.year !== undefined && !isWholeNumber(date.year, 1, 9999)) return null;
  }
  if (time.zone !== undefined) {
    const zone = time.zone as Record<string, unknown> | null;
    if (typeof zone !== "object" || zone === null) return null;
    const isOffset = isWholeNumber(zone.offsetMinutes, -14 * 60, 14 * 60);
    const isRegion = typeof zone.timeZone === "string" && zone.timeZone.length > 0;
    if (!isOffset && !isRegion) return null;
    if (zone.name !== undefined && typeof zone.name !== "string") return null;
  }
  return time as MentionedTime;
}
