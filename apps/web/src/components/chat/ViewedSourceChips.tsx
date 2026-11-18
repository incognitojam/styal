import {
  foldViewedSources,
  viewedDocumentPagesLabel,
  viewedSourceLabel,
  type ViewedSource,
} from "@t3tools/client-runtime/work-log/presentation";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { use, useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";
import { MarkdownLinkFavicon } from "./MarkdownExternalLink";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { TimelineRowCtx } from "./timelineRowContext";

const FOLD_LIMIT = 4;

export function ViewedSourceChips({ sources }: { sources: ReadonlyArray<ViewedSource> }) {
  const { threadRef, workspaceRoot, resolvedTheme, onExternalLinkContextMenu } =
    use(TimelineRowCtx);
  const openLink = useOpenLink(threadRef);
  const [expanded, setExpanded] = useState(false);
  const { visible, hiddenCount } = foldViewedSources(sources, FOLD_LIMIT, expanded);
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-0.5">
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
        return (
          <Button
            key={source.url}
            variant="outline"
            size="xs"
            className="max-w-full"
            title={source.url}
            render={<a href={source.url} target="_blank" rel="noopener noreferrer" />}
            onClick={(event) => {
              event.preventDefault();
              void openLink(source.url, { event });
            }}
            onContextMenu={(event) => onExternalLinkContextMenu(event, source.url)}
          >
            <MarkdownLinkFavicon host={new URL(source.url).host} />
            <span className="truncate">{label}</span>
          </Button>
        );
      })}
      {sources.length > FOLD_LIMIT ? (
        <Button variant="ghost-muted" size="xs" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `+${hiddenCount} more`}
        </Button>
      ) : null}
    </div>
  );
}
