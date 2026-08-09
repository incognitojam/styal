import { describe, expect, it } from "vite-plus/test";

import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";

describe("normalizeDesktopUpdateReleaseNotes", () => {
  it("splits a plain string note into items under the fallback version", () => {
    const notes = normalizeDesktopUpdateReleaseNotes(
      "## What's changed\n- First fix\n- Second fix",
      "1.2.3",
    );
    expect(notes).toEqual([{ version: "1.2.3", items: ["First fix", "Second fix"] }]);
  });

  it("keeps per-version groups and drops empty ones", () => {
    const notes = normalizeDesktopUpdateReleaseNotes(
      [
        { version: "1.2.3", note: "- Newer change" },
        { version: "1.2.2", note: "Full changelog: https://example.com/compare/x...y" },
        { version: "1.2.1", note: "- Older change" },
      ],
      "1.2.3",
    );
    expect(notes).toEqual([
      { version: "1.2.3", items: ["Newer change"] },
      { version: "1.2.1", items: ["Older change"] },
    ]);
  });

  it("decodes valid HTML entities", () => {
    const notes = normalizeDesktopUpdateReleaseNotes("- Fix &amp; polish &#128512;", "1.0.0");
    expect(notes).toEqual([{ version: "1.0.0", items: ["Fix & polish 😀"] }]);
  });

  it("ignores malformed entries instead of throwing", () => {
    const notes = normalizeDesktopUpdateReleaseNotes(
      [
        { version: "1.2.3", note: "- Valid change" },
        { version: 42, note: "- Bad version type" },
        { version: "1.2.1", note: { html: "<p>object note</p>" } },
        "not an object",
        null,
      ],
      "1.2.3",
    );
    expect(notes).toEqual([{ version: "1.2.3", items: ["Valid change"] }]);
  });

  it("returns non-empty groups even when preceded by many boilerplate-only groups", () => {
    const boilerplate = Array.from({ length: 7 }, (_, index) => ({
      version: `1.3.${9 - index}`,
      note: "Full changelog: https://example.com/compare/x...y",
    }));
    const notes = normalizeDesktopUpdateReleaseNotes(
      [...boilerplate, { version: "1.3.2", note: "- Older but real change" }],
      "1.3.9",
    );
    expect(notes).toEqual([{ version: "1.3.2", items: ["Older but real change"] }]);
  });

  it("keeps only curated highlights when the commit list follows them", () => {
    const notes = normalizeDesktopUpdateReleaseNotes(
      [
        "- **Added:** Start threads from GitHub issues ([#14](https://example.com/pull/14))",
        "- **Improved:** Show setup script outcomes ([t3code#12083](https://example.com/pull/12083))",
        "",
        "## What's Changed",
        "",
        "- fix(release): generate clearer nightly changelogs ([yngatech/t3code#59](https://example.com/pull/59)) by @cameron",
        "",
        "**Full Changelog**: https://example.com/compare/x...y",
      ].join("\n"),
      "1.2.3",
    );
    expect(notes).toEqual([
      {
        version: "1.2.3",
        items: [
          "Added: Start threads from GitHub issues (#14)",
          "Improved: Show setup script outcomes (t3code#12083)",
        ],
      },
    ]);
  });

  it("does not throw on out-of-range numeric entities and keeps the literal", () => {
    expect(() =>
      normalizeDesktopUpdateReleaseNotes("- Broken entity &#9999999999;", "1.0.0"),
    ).not.toThrow();
    const notes = normalizeDesktopUpdateReleaseNotes("- Broken entity &#9999999999;", "1.0.0");
    expect(notes).toEqual([{ version: "1.0.0", items: ["Broken entity &#9999999999;"] }]);
  });
});
