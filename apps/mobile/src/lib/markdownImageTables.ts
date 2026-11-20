import type { Image, Nodes, Table } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { renderCodexInlineDirectivesAsMarkdown } from "@t3tools/shared/codexMarkdownDirectives";
import { parseMarkdownDocument } from "./markdownDocument";

const parser = unified().use(remarkParse).use(remarkGfm);

export interface MarkdownImageTableCell {
  readonly header: string;
  readonly image: {
    readonly href: string;
    readonly alt: string | null;
    readonly title: string | null;
  } | null;
}

export type MarkdownImageTableSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly sourceOffset: number }
  | {
      readonly kind: "image-table";
      readonly rows: ReadonlyArray<ReadonlyArray<MarkdownImageTableCell>>;
      readonly sourceOffset: number;
    };

// What a cell of a streaming row can hold before its image is complete: `!`, `![alt`, `![alt](src`.
const PARTIAL_IMAGE = /^!(?:\[[^\]]*(?:\]\([^)]*)?)?$/;
const PLAIN_HEADER = new Set(["text", "emphasis", "strong", "inlineCode"]);

function text(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(text).join("") : "";
}

function plain(node: Nodes): boolean {
  return PLAIN_HEADER.has(node.type) && (!("children" in node) || node.children.every(plain));
}

/** The rows of a top-level table whose body cells each hold one image (or nothing), else null. */
function imageTableRows(table: Table, markdown: string) {
  const source = (node: Nodes) =>
    markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
  const [head, ...body] = table.children;
  if (!head || body.length === 0) return null;
  // Links and directives in a header need the native renderer to stay interactive.
  if (
    !head.children.every((cell) => cell.children.every(plain)) ||
    head.children.some(
      (cell) => renderCodexInlineDirectivesAsMarkdown(source(cell)) !== source(cell),
    )
  ) {
    return null;
  }
  const headers = head.children.map((cell) => text(cell).trim());
  const tableEnd = table.position?.end.offset ?? markdown.length;
  // The last row may still be arriving: nothing after it yet, not even its line break.
  const streaming = !markdown.slice(tableEnd).includes("\n");
  const rows: MarkdownImageTableCell[][] = [];
  for (const [rowIndex, row] of body.entries()) {
    const unfinished = streaming && rowIndex === body.length - 1;
    // GFM pads a short row and drops cells past the header.
    const cells = headers.map((header, index): MarkdownImageTableCell | null => {
      const cell = row.children[index];
      const content = (cell?.children ?? []).filter(
        (child) => child.type !== "text" || child.value.trim().length > 0,
      );
      const only = content[0];
      if (content.length === 1 && only?.type === "image") {
        // Parsed again as the app parses messages, so Windows paths keep their backslashes.
        const image =
          parseMarkdownDocument(source(only)).children.flatMap((node) =>
            node.type === "paragraph"
              ? node.children.filter((child): child is Image => child.type === "image")
              : [],
          )[0] ?? only;
        return {
          header,
          image: { href: image.url, alt: image.alt || null, title: image.title ?? null },
        };
      }
      const raw = cell
        ? source(cell)
            .replace(/^\s*\|/, "")
            .replace(/\|\s*$/, "")
            .trim()
        : "";
      return content.length === 0 || (unfinished && PARTIAL_IMAGE.test(raw))
        ? { header, image: null }
        : null;
    });
    if (cells.some((cell) => cell === null)) return null;
    rows.push(cells.filter((cell) => cell !== null));
  }
  return rows.some((cells) => cells.some((cell) => cell.image !== null)) ? rows : null;
}

/** Splits out top-level tables made only of images, so they can be drawn as rows of thumbnails. */
export function splitMarkdownImageTables(
  markdown: string,
): ReadonlyArray<MarkdownImageTableSegment> {
  if (!markdown.includes("|") || !markdown.includes("![")) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }
  const segments: MarkdownImageTableSegment[] = [];
  let cursor = 0;
  const root = parser.parse(markdown);
  // Reference definitions apply across the whole message; splitting it would break them.
  if (root.children.some((node) => node.type === "definition")) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }
  for (const node of root.children) {
    if (node.type !== "table") continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const rows = imageTableRows(node, markdown);
    if (start === undefined || end === undefined || rows === null) continue;
    if (start > cursor) {
      segments.push({
        kind: "markdown",
        markdown: markdown.slice(cursor, start),
        sourceOffset: cursor,
      });
    }
    segments.push({ kind: "image-table", rows, sourceOffset: start });
    cursor = end;
  }
  if (cursor < markdown.length || segments.length === 0) {
    segments.push({ kind: "markdown", markdown: markdown.slice(cursor), sourceOffset: cursor });
  }
  return segments;
}
