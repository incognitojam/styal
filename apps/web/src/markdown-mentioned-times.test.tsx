import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_SANITIZE_SCHEMA } from "./components/ChatMarkdown";
import { readMentionedTime, remarkMentionedTimes } from "./markdown-mentioned-times";

function renderMarkdown(markdown: string) {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMentionedTimes]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

function mentionedTimes(html: string): unknown[] {
  return [...html.matchAll(/data-mentioned-time="([^"]*)"/g)].map((match) =>
    readMentionedTime(match[1]!.replaceAll("&quot;", '"')),
  );
}

describe("remarkMentionedTimes", () => {
  it("marks a time in prose and keeps its text, through the chat sanitizer", () => {
    const html = renderMarkdown("PR 330 merged at **14:39 UTC**.");

    expect(html).toContain(">14:39 UTC</span>");
    expect(mentionedTimes(html)).toEqual([
      {
        kind: "clock",
        hour: 14,
        minute: 39,
        zone: { offsetMinutes: 0, name: "UTC" },
        tense: "past",
      },
    ]);
  });

  it("reads a zone-less time in the zone the rest of the message uses", () => {
    const html = renderMarkdown(
      "| Time (UTC) | Event |\n|---|---|\n| 12:17:07 | Worktree created |\n\nAt **14:52**, #463 merged.",
    );

    expect(mentionedTimes(html)).toEqual([
      expect.objectContaining({
        hour: 12,
        zone: { offsetMinutes: 0, name: "UTC" },
        zoneFromMessage: true,
      }),
      expect.objectContaining({
        hour: 14,
        zone: { offsetMinutes: 0, name: "UTC" },
        zoneFromMessage: true,
      }),
    ]);
  });

  it("leaves times in code and link labels alone", () => {
    const html = renderMarkdown(
      "Run `sleep-until 14:39 UTC`, see [the 14:39 UTC run](https://example.com/run).\n\n```\n14:39 UTC\n```",
    );

    expect(mentionedTimes(html)).toEqual([]);
  });
});

describe("readMentionedTime", () => {
  it("ignores an attribute that raw HTML spelled with the wrong shape", () => {
    expect(readMentionedTime('{"kind":"clock","hour":25,"minute":0}')).toBeNull();
    expect(readMentionedTime('{"kind":"offset","milliseconds":"soon"}')).toBeNull();
    expect(readMentionedTime('{"kind":"clock","hour":9,"minute":0,"zone":{}}')).toBeNull();
    expect(readMentionedTime("not json")).toBeNull();
  });
});
