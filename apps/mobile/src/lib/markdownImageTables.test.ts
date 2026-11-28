import { describe, expect, it } from "vite-plus/test";
import { splitMarkdownImageTables } from "./markdownImageTables";

const pair = "| Before | After |\n| --- | --- |\n| ![Old list](a.png) | ![New list](b.png) |\n";

describe("splitMarkdownImageTables", () => {
  it("splits out an image-only table with its headers and alt text, keeping the text around it", () => {
    const markdown = `Intro\n\n${pair}\nOutro`;
    const segments = splitMarkdownImageTables(markdown);
    expect(segments).toEqual([
      { kind: "markdown", markdown: "Intro\n\n", sourceOffset: 0 },
      {
        kind: "image-table",
        sourceOffset: 7,
        rows: [
          [
            { header: "Before", image: { href: "a.png", alt: "Old list", title: null } },
            { header: "After", image: { href: "b.png", alt: "New list", title: null } },
          ],
        ],
      },
      { kind: "markdown", markdown: "\n\nOutro", sourceOffset: markdown.indexOf("\n\nOutro") },
    ]);
  });

  it.each([
    ["a text column", "| Case | Shot |\n| --- | --- |\n| Empty | ![a](a.png) |\n"],
    ["a linked image", "| A |\n| --- |\n| [![a](a.png)](https://example.com) |\n"],
    ["text beside an image", "| A |\n| --- |\n| See ![a](a.png) |\n"],
    ["a header only", "| A | B |\n| --- | --- |\n"],
    ["a nested table", "- item\n\n  | A |\n  | --- |\n  | ![a](a.png) |\n"],
    ["a linked header", "| [A](https://example.com) |\n| --- |\n| ![a](a.png) |\n"],
    [
      "a reference definition elsewhere in the message",
      "See [docs][r].\n\n| A |\n| --- |\n| ![a](a.png) |\n\n[r]: https://example.com\n",
    ],
  ])("leaves a table with %s to the native renderer", (_, markdown) => {
    expect(splitMarkdownImageTables(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("sizes each row to the header and keeps Windows paths as the app reads them", () => {
    const markdown =
      "| A | B | C |\n| --- | --- | --- |\n| ![a](C:\\work\\.t3\\a.png) |\n| ![b](b.png) | ![c](c.png) | ![d](d.png) | ![e](e.png) |\n";
    const [segment] = splitMarkdownImageTables(markdown);
    expect(
      segment?.kind === "image-table"
        ? segment.rows.map((cells) => cells.map((cell) => [cell.header, cell.image?.href ?? null]))
        : segment,
    ).toEqual([
      [
        ["A", "C:\\work\\.t3\\a.png"],
        ["B", null],
        ["C", null],
      ],
      [
        ["A", "b.png"],
        ["B", "c.png"],
        ["C", "d.png"],
      ],
    ]);
  });

  it("keeps a streaming row as an image row while its cells are unfinished images", () => {
    const rows = (markdown: string) =>
      splitMarkdownImageTables(markdown).flatMap((segment) =>
        segment.kind === "image-table"
          ? [segment.rows.map((cells) => cells.map((cell) => cell.image?.href ?? null))]
          : [],
      );
    const streamed =
      "| A | B |\n| --- | --- |\n| ![a](a.png) | ![b](b.png) |\n| ![c](c.png) | ![d](d";
    expect(rows(streamed)).toEqual([
      [
        ["a.png", "b.png"],
        ["c.png", null],
      ],
    ]);
    // Text in the last row makes it a native table, finished or not.
    expect(rows("| A | B |\n| --- | --- |\n| ![a](a.png) | ![b](b.png) |\n| Total | 2")).toEqual(
      [],
    );
    // Code that merely looks like the start of an image is text, even in a last row.
    expect(rows("| A | B |\n| --- | --- |\n| ![a](a.png) | `!`")).toEqual([]);
    // Once the row has ended, an unfinished-looking cell is plain text.
    expect(rows("| A | B |\n| --- | --- |\n| ![a](a.png) | ![b\n\nNext")).toEqual([]);
  });
});
