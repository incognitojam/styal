import { ASSISTANT_CITATION_CONTEXT_LENGTH } from "@t3tools/contracts";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { characterEntities } from "character-entities";

const ENTITY = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z][a-zA-Z\d]*));?/g;
const PERCENT_ESCAPE = /%[\da-fA-F]{2}(?:%[\da-fA-F]{2})*/g;
// Markdown drops a backslash before punctuation, and URL parsers drop tabs and line breaks.
const MARKDOWN_ESCAPE = /\\(?=[!-/:-@[-`{-~])|[\t\n\r]/g;
const INVISIBLE = /[\p{Cf}\p{Mn}]/gu;

const codePointOrEmpty = (codePoint: number) =>
  codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";

function decodeOnce(text: string): string {
  return text
    .replace(ENTITY, (source, decimal: string, hex: string, name: string) =>
      decimal !== undefined
        ? codePointOrEmpty(Number(decimal))
        : hex !== undefined
          ? codePointOrEmpty(Number.parseInt(hex, 16))
          : (characterEntities[name] ?? source),
    )
    .replace(PERCENT_ESCAPE, (source) => {
      try {
        return decodeURIComponent(source);
      } catch {
        return source;
      }
    })
    .replace(MARKDOWN_ESCAPE, "")
    .normalize("NFKC")
    .replace(INVISIBLE, "");
}

/**
 * Whether a guest's own text names a citation in any spelling. Guests quote through the composer,
 * whose quotes the server builds, so free text never needs one, and refusing every spelling the
 * renderer could read as one is simpler than matching how each renders.
 */
export function guestTextHasCitation(text: string): boolean {
  let decoded = text;
  // Each pass undoes one layer, such as `&amp;#116;` or `%2526`.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = decodeOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.toLowerCase().includes("t3-citation");
}

const collapseWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function selectorAt(text: string, start: number, end: number) {
  let prefixStart = Math.max(0, start - ASSISTANT_CITATION_CONTEXT_LENGTH);
  let suffixEnd = Math.min(text.length, end + ASSISTANT_CITATION_CONTEXT_LENGTH);
  if (splitsSurrogatePair(text, prefixStart)) prefixStart += 1;
  if (splitsSurrogatePair(text, suffixEnd)) suffixEnd -= 1;
  return { start, end, prefix: text.slice(prefixStart, start), suffix: text.slice(end, suffixEnd) };
}

/**
 * A guest's quote as a citation selector in the reply it names, or null when the reply doesn't
 * show it. Searches the rendered text, then the Markdown for what renders differently, such as a
 * formula. Whitespace runs compare equal, since block breaks render as line breaks.
 */
export function locateGuestQuote(quote: string, markdown: string) {
  const target = collapseWhitespace(quote);
  if (target === "") return null;
  const rendered = collapseWhitespace(
    (searchableMessageSegments({ role: "assistant", text: markdown, streaming: false }) ?? []).join(
      " ",
    ),
  );
  for (const text of [rendered, collapseWhitespace(markdown)]) {
    const start = text.indexOf(target);
    if (start !== -1) return selectorAt(text, start, start + target.length);
  }
  return null;
}
