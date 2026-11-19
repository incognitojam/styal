import {
  foldViewedSources,
  viewedDocumentPagesLabel,
  viewedSearchResultSite,
  viewedSourceLabel,
  viewedSourcesSummary,
  type ViewedSource,
} from "@t3tools/client-runtime/work-log/presentation";
import { viewedSearchKey } from "@t3tools/shared/viewedSources";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { use, useState, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useRightPanelStore } from "~/rightPanelStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { MarkdownLinkFavicon } from "./MarkdownExternalLink";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { TimelineRowCtx } from "./timelineRowContext";

const FOLD_LIMIT = 4;

type SearchSource = Extract<ViewedSource, { kind: "search" }>;

export function ViewedSourceChips(props: {
  readonly rowId: string;
  readonly sources: ReadonlyArray<ViewedSource>;
  readonly collapsedGroupId: string | null;
  /** Rest as one summary line, such as "2 pages · 1 search", that opens the chips. */
  readonly folded?: boolean | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const openKey = `viewed-sources:${props.rowId}`;
  const [open, setOpen] = useState(() => ctx.workGroupViewState.expandedEntries.has(openKey));
  if (!props.folded) return <SourceChips {...props} />;
  const toggle = () => {
    ctx.onToggleWorkEntry(props.rowId, open);
    if (open) ctx.workGroupViewState.expandedEntries.delete(openKey);
    else ctx.workGroupViewState.expandedEntries.add(openKey);
    setOpen(!open);
  };
  return (
    // Indented to the subagent row's title, so the line reads as part of that row.
    <div className="flex flex-col items-start gap-1 ps-8.5">
      <Button variant="ghost-muted" size="xs" aria-expanded={open} onClick={toggle}>
        {viewedSourcesSummary(props.sources)}
        <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
      </Button>
      {open ? <SourceChips {...props} /> : null}
    </div>
  );
}

function SourceChips(props: {
  readonly rowId: string;
  readonly sources: ReadonlyArray<ViewedSource>;
  readonly collapsedGroupId: string | null;
}) {
  const { sources } = props;
  const ctx = use(TimelineRowCtx);
  const { threadRef, workspaceRoot, resolvedTheme, onExternalLinkContextMenu } = ctx;
  const openLink = useOpenLink(threadRef);
  const [expanded, setExpanded] = useState(false);
  const [openSearchKey, setOpenSearchKey] = useState<string | null>(null);
  const { visible, hiddenCount } = foldViewedSources(sources, FOLD_LIMIT, expanded);
  const openSearch = visible.find(
    (source): source is SearchSource =>
      source.kind === "search" && viewedSearchKey(source.query) === openSearchKey,
  );
  const pageLink = (url: string, children: ReactNode, variant: "outline" | "ghost" = "outline") => (
    <Button
      key={url}
      variant={variant}
      size="xs"
      className="max-w-full"
      title={url}
      render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      onClick={(event) => {
        event.preventDefault();
        void openLink(url, { event });
      }}
      onContextMenu={(event) => onExternalLinkContextMenu(event, url)}
    >
      <MarkdownLinkFavicon host={new URL(url).host} />
      {children}
    </Button>
  );
  return (
    <div className="flex flex-col gap-1.5 px-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {visible.map((source) => {
          const label = viewedSourceLabel(source);
          if (source.kind === "document") {
            const pages = viewedDocumentPagesLabel(source.pages);
            return (
              <Button
                key={source.path}
                variant="outline"
                size="xs"
                className="max-w-full"
                title={source.path}
                disabled={!threadRef}
                onClick={() => {
                  if (!threadRef) return;
                  useRightPanelStore
                    .getState()
                    .openFile(
                      threadRef,
                      workspaceRelativeFilePath(source.path, workspaceRoot) ?? source.path,
                    );
                }}
              >
                <PierreEntryIcon pathValue={source.path} kind="file" theme={resolvedTheme} />
                <span className="truncate">{label}</span>
                {pages ? <span className="text-muted-foreground">{pages}</span> : null}
              </Button>
            );
          }
          if (source.kind === "page") {
            return pageLink(source.url, <span className="truncate">{label}</span>);
          }
          const key = viewedSearchKey(source.query);
          const content = (
            <>
              <SearchIcon />
              <span className="max-w-64 truncate">{label}</span>
            </>
          );
          if (source.results.length > 0) {
            return (
              <Button
                key={`search:${key}`}
                variant="outline"
                size="xs"
                className="max-w-full"
                aria-expanded={openSearchKey === key}
                title={`Results for "${source.query}"`}
                onClick={() => setOpenSearchKey(openSearchKey === key ? null : key)}
              >
                {content}
                <span className="text-muted-foreground">{source.results.length}</span>
              </Button>
            );
          }
          // Without results, the chip opens the tool group that holds the search.
          return props.collapsedGroupId ? (
            <Button
              key={`search:${key}`}
              variant="outline"
              size="xs"
              className="max-w-full"
              title={`Show the search for "${source.query}"`}
              onClick={() => ctx.onToggleWorkGroup(props.collapsedGroupId!, props.rowId)}
            >
              {content}
            </Button>
          ) : (
            <Badge
              key={`search:${key}`}
              variant="outline"
              size="control"
              className="max-w-full"
              title={source.query}
            >
              {content}
            </Badge>
          );
        })}
        {sources.length > FOLD_LIMIT ? (
          <Button variant="ghost-muted" size="xs" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : `+${hiddenCount} more`}
          </Button>
        ) : null}
      </div>
      {openSearch ? (
        <ul className="flex flex-col gap-0.5" aria-label={`Results for "${openSearch.query}"`}>
          {openSearch.results.map((result) => (
            <li key={result.url} className="flex">
              {pageLink(
                result.url,
                <>
                  <span className="truncate">
                    {result.title ?? viewedSearchResultSite(result.url)}
                  </span>
                  {result.title ? (
                    <span className="text-muted-foreground">
                      {viewedSearchResultSite(result.url)}
                    </span>
                  ) : null}
                </>,
                "ghost",
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
