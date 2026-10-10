import { renderToStaticMarkup } from "react-dom/server";
import { resolveMentionedTime, type MentionedTime } from "@t3tools/client-runtime/mentioned-times";
import type { Root, RootContent } from "mdast";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_SANITIZE_SCHEMA } from "./components/ChatMarkdown";
import {
  MENTIONED_TIME_PROPERTY,
  readMentionedTime,
  remarkMentionedTimes,
} from "./markdown-mentioned-times";

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
  it("resolves bold timeline labels in their written zone while leaving code and links alone", () => {
    const times: MentionedTime[] = [];
    const collect = (node: Root | RootContent): void => {
      const properties = node.data?.hProperties;
      if (typeof properties === "object" && properties !== null) {
        const time = readMentionedTime(
          (properties as Record<string, unknown>)[MENTIONED_TIME_PROPERTY],
        );
        if (time) times.push(time);
      }
      if ("children" in node) node.children.forEach(collect);
    };
    ReactMarkdown({
      children: [
        "- **15:55:19 UTC:** the worker started.",
        "- **15:55:43:** a message arrived.",
        "- **About 15:55:45:** startup catch-up was still running.",
        "",
        "The reply was sent at `15:55:46`.",
        "[15:55:43:](https://example.com/run) and src/example.ts:12:34: stay plain.",
        "",
        "```text",
        "15:55:43:",
        "```",
      ].join("\n"),
      remarkPlugins: [remarkGfm, remarkMentionedTimes, () => collect],
    });

    expect(times).toHaveLength(3);
    expect(times[0]).toEqual({
      kind: "clock",
      hour: 15,
      minute: 55,
      second: 19,
      zone: { offsetMinutes: 0, name: "UTC" },
    });
    expect(times.slice(1)).toEqual([
      {
        kind: "clock",
        hour: 15,
        minute: 55,
        second: 43,
        zone: { offsetMinutes: 0, name: "UTC" },
        zoneFromMessage: true,
      },
      {
        kind: "clock",
        hour: 15,
        minute: 55,
        second: 45,
        zone: { offsetMinutes: 0, name: "UTC" },
        zoneFromMessage: true,
      },
    ]);
    expect(
      times.map(
        (time) =>
          resolveMentionedTime(time, {
            writtenAtMs: Date.parse("2026-10-10T16:02:00Z"),
            environmentTimeZone: "America/Los_Angeles",
          })?.instantMs,
      ),
    ).toEqual([
      Date.parse("2026-10-10T15:55:19Z"),
      Date.parse("2026-10-10T15:55:43Z"),
      Date.parse("2026-10-10T15:55:45Z"),
    ]);
  });

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
