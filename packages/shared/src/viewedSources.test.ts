import { describe, expect, it } from "vite-plus/test";

import {
  SUBAGENT_SEARCH_RESULTS_LIMIT,
  SUBAGENT_VIEWED_SOURCES_LIMIT,
  subagentViewedSourceSummary,
  type ViewedSourceItem,
} from "./viewedSources.ts";

const fetch = (
  url: string,
  status: ViewedSourceItem["status"] = "completed",
): ViewedSourceItem => ({
  type: "web_search",
  status,
  patterns: [url],
  fetchedUrl: url,
});

describe("subagentViewedSourceSummary", () => {
  it("merges a subagent's own sources with those of the subagents it started", () => {
    expect(
      subagentViewedSourceSummary([
        {
          type: "web_search",
          status: "completed",
          patterns: ["retention policy"],
          results: [{ url: "https://docs.example.com/retention", title: "Retention" }],
        },
        fetch("https://docs.example.com/retention"),
        {
          type: "dynamic_tool",
          status: "completed",
          viewedDocument: { path: "/repo/contracts/vendor-a.pdf", pages: "1-4" },
        },
        // A nested subagent's summary rolls up; it failed but had read these first.
        {
          type: "subagent",
          status: "failed",
          viewedSources: [
            { kind: "page", url: "https://docs.example.com/retention/" },
            { kind: "page", url: "https://legal.example.net/terms" },
          ],
        },
        // Stopped after reading this page; the page still counts.
        {
          type: "subagent",
          status: "cancelled",
          viewedSources: [{ kind: "page", url: "https://status.example.org/uptime" }],
        },
        fetch("https://help.example.io/export", "failed"),
      ]),
    ).toEqual([
      { kind: "document", path: "/repo/contracts/vendor-a.pdf", pages: "1-4" },
      { kind: "page", url: "https://docs.example.com/retention" },
      { kind: "page", url: "https://legal.example.net/terms" },
      { kind: "page", url: "https://status.example.org/uptime" },
      {
        kind: "search",
        query: "retention policy",
        results: [{ url: "https://docs.example.com/retention", title: "Retention" }],
      },
    ]);
  });

  it("caps the sources, the results per search and their text", () => {
    const summary = subagentViewedSourceSummary([
      {
        type: "web_search",
        status: "completed",
        patterns: ["vendor terms"],
        results: Array.from({ length: 9 }, (_, index) => ({
          url: `https://docs.example.com/terms/${index}`,
          title: index === 0 ? "T".repeat(500) : `Terms ${index}`,
        })),
      },
      fetch(`https://docs.example.com/${"long/".repeat(500)}`),
      ...Array.from({ length: 60 }, (_, index) => fetch(`https://docs.example.com/page-${index}`)),
    ]);
    expect(summary).toHaveLength(SUBAGENT_VIEWED_SOURCES_LIMIT);
    // An over-long address is left out, not shortened into a different page.
    expect(summary.some((source) => source.kind === "page" && source.url.includes("long/"))).toBe(
      false,
    );
    const pages = summary.filter((source) => source.kind === "page");
    expect(pages.at(-1)).toEqual({
      kind: "page",
      url: `https://docs.example.com/page-${SUBAGENT_VIEWED_SOURCES_LIMIT - 1}`,
    });
    const search = subagentViewedSourceSummary([
      {
        type: "web_search",
        status: "completed",
        patterns: ["vendor terms"],
        results: Array.from({ length: 9 }, (_, index) => ({
          url: `https://docs.example.com/terms/${index}`,
          ...(index === 0 ? { title: "T".repeat(500) } : {}),
        })),
      },
    ])[0];
    expect(search?.kind === "search" ? search.results : []).toHaveLength(
      SUBAGENT_SEARCH_RESULTS_LIMIT,
    );
    expect(search?.kind === "search" ? search.results[0]?.title?.length : 0).toBe(200);
  });
});
