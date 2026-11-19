import type { OrchestrationV2TurnItem, OrchestrationV2ViewedSource } from "@t3tools/contracts";

/** A document an agent read, a page it fetched, or a web search it ran. */
export type ViewedSource = OrchestrationV2ViewedSource;
export type ViewedSearchResult = Extract<ViewedSource, { kind: "search" }>["results"][number];

type TurnItemOf<Type extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { readonly type: Type }
>;

/** The turn item fields the sources come from; a server query can select only these. */
export type ViewedSourceItem =
  | Pick<TurnItemOf<"dynamic_tool">, "type" | "status" | "toolNonExecutionKind" | "viewedDocument">
  | Pick<
      TurnItemOf<"web_search">,
      "type" | "status" | "toolNonExecutionKind" | "fetchedUrl" | "patterns" | "results"
    >
  | Pick<TurnItemOf<"subagent">, "type" | "status" | "viewedSources">
  | {
      readonly type: Exclude<
        OrchestrationV2TurnItem["type"],
        "dynamic_tool" | "web_search" | "subagent"
      >;
      readonly status: OrchestrationV2TurnItem["status"];
    };

/** `text` without any of `characters` at its end; a backward scan, linear in a long run. */
export function withoutTrailing(text: string, characters: string): string {
  let end = text.length;
  while (end > 0 && characters.includes(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

/** Host, path and query of an http(s) URL; the scheme, fragment and trailing slash do not count. */
export function viewedSourceUrlKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.host}${withoutTrailing(parsed.pathname, "/")}${parsed.search}`;
}

/** Same query regardless of case and spacing. */
export function viewedSearchKey(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

/** One key per document, page or query, the same however often it was used. */
export function viewedSourceKey(source: ViewedSource): string {
  return source.kind === "document"
    ? `document:${source.path}`
    : source.kind === "page"
      ? `page:${viewedSourceUrlKey(source.url)}`
      : `search:${viewedSearchKey(source.query)}`;
}

export function turnItemViewedSources(item: ViewedSourceItem): ReadonlyArray<ViewedSource> {
  // A subagent's summary lists what it read before it failed or was stopped.
  if (item.type === "subagent") return item.viewedSources ?? [];
  if (
    item.status === "cancelled" ||
    item.status === "failed" ||
    (item.type !== "dynamic_tool" && item.type !== "web_search") ||
    item.toolNonExecutionKind !== undefined
  ) {
    return [];
  }
  if (item.type === "dynamic_tool") {
    if (item.viewedDocument === undefined) return [];
    const { path, pages } = item.viewedDocument;
    return [{ kind: "document", path, ...(pages === undefined ? {} : { pages }) }];
  }
  if (item.fetchedUrl !== undefined) {
    return viewedSourceUrlKey(item.fetchedUrl) === null
      ? []
      : [{ kind: "page", url: item.fetchedUrl }];
  }
  // Codex batches several queries in one item; each is a chip. A lone URL is a fetch the adapter
  // did not mark with fetchedUrl, not a search.
  const queries = (item.patterns ?? [])
    .map((pattern) => pattern.replace(/\s+/g, " ").trim())
    .filter((query) => query.length > 0 && viewedSourceUrlKey(query) === null);
  const results = (item.results ?? []).flatMap((result) => {
    const title = result.title?.trim();
    return result.url !== undefined && viewedSourceUrlKey(result.url) !== null
      ? [{ url: result.url, ...(title ? { title } : {}) }]
      : [];
  });
  // Results are reported per item, not per query, so they stay with the first query.
  return queries.map((query, index) => ({
    kind: "search",
    query,
    results: index === 0 ? results : [],
  }));
}

/** Documents, then pages, then searches, each once and in the order they were first used. */
export function mergeViewedSources(sources: Iterable<ViewedSource>): ViewedSource[] {
  const documents = new Map<string, ViewedSource>();
  const pages = new Map<string, ViewedSource>();
  const searches = new Map<
    string,
    { readonly query: string; readonly results: ViewedSearchResult[]; readonly urls: Set<string> }
  >();
  for (const source of sources) {
    if (source.kind === "document") {
      const seen = documents.get(source.path);
      if (seen === undefined) documents.set(source.path, source);
      // Reads of different ranges of one document show the document without a range.
      else if (seen.kind === "document" && seen.pages !== source.pages) {
        documents.set(source.path, { kind: "document", path: source.path });
      }
    } else if (source.kind === "page") {
      const key = viewedSourceUrlKey(source.url);
      if (key !== null && !pages.has(key)) pages.set(key, source);
    } else {
      const key = viewedSearchKey(source.query);
      const search = searches.get(key) ?? { query: source.query, results: [], urls: new Set() };
      searches.set(key, search);
      for (const result of source.results) {
        const url = viewedSourceUrlKey(result.url);
        if (url === null || search.urls.has(url)) continue;
        search.urls.add(url);
        search.results.push(result);
      }
    }
  }
  return [
    ...documents.values(),
    ...pages.values(),
    ...[...searches.values()].map(({ query, results }) => ({
      kind: "search" as const,
      query,
      results,
    })),
  ];
}

/** Bounds a subagent's summary: this many sources, and this many results per search. */
export const SUBAGENT_VIEWED_SOURCES_LIMIT = 40;
export const SUBAGENT_SEARCH_RESULTS_LIMIT = 5;
const SUBAGENT_SOURCE_TEXT_LIMIT = 2_000;
const SUBAGENT_RESULT_TITLE_LIMIT = 200;

const fits = (text: string) => text.length <= SUBAGENT_SOURCE_TEXT_LIMIT;

/**
 * The capped summary a subagent's turn item carries in its parent thread. A source whose path,
 * address or query is too long is left out rather than shortened into a wrong target.
 */
export function subagentViewedSourceSummary(
  items: Iterable<ViewedSourceItem>,
): ReadonlyArray<ViewedSource> {
  const merged = mergeViewedSources(
    (function* () {
      for (const item of items) yield* turnItemViewedSources(item);
    })(),
  );
  return merged
    .flatMap((source): ViewedSource[] => {
      if (source.kind === "document") {
        return fits(source.path) && (source.pages === undefined || fits(source.pages))
          ? [source]
          : [];
      }
      if (source.kind === "page") return fits(source.url) ? [source] : [];
      if (!fits(source.query)) return [];
      return [
        {
          kind: "search",
          query: source.query,
          results: source.results
            .filter((result) => fits(result.url))
            .slice(0, SUBAGENT_SEARCH_RESULTS_LIMIT)
            .map((result) => ({
              url: result.url,
              ...(result.title === undefined
                ? {}
                : { title: result.title.slice(0, SUBAGENT_RESULT_TITLE_LIMIT) }),
            })),
        },
      ];
    })
    .slice(0, SUBAGENT_VIEWED_SOURCES_LIMIT);
}
