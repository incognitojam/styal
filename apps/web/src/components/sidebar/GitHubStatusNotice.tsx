import { ExternalLinkIcon, GithubIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  GITHUB_STATUS_PAGE_URL,
  GITHUB_STATUS_SUMMARY_URL,
  resolveGitHubStatusNotice,
  type GitHubStatusNotice as GitHubStatusNoticeView,
} from "../../githubStatus";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const GITHUB_STATUS_POLL_INTERVAL_MS = 60_000;

function GitHubStatusTooltip({ notice }: { readonly notice: GitHubStatusNoticeView }) {
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] p-[var(--floating-content-inset)] text-left">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <GithubIcon className="size-4" />
        {notice.description}
      </div>
      {notice.affectedComponents.length > 0 ? (
        <div className="mt-2 grid gap-1.5">
          {notice.affectedComponents.map((component) => (
            <div className="flex items-center justify-between gap-4" key={component.name}>
              <span className="truncate text-muted-foreground">{component.name}</span>
              <span className="shrink-0 text-foreground/80">{component.statusLabel}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function GitHubStatusNotice() {
  const [notice, setNotice] = useState<GitHubStatusNoticeView | null>(null);

  useEffect(() => {
    let cancelled = false;
    let nextRefresh: number | undefined;
    let activeRequest: AbortController | undefined;

    const refresh = async () => {
      activeRequest = new AbortController();
      try {
        const response = await fetch(GITHUB_STATUS_SUMMARY_URL, {
          headers: { Accept: "application/json" },
          signal: activeRequest.signal,
        });
        if (!response.ok) return;
        const summary: unknown = await response.json();
        if (!cancelled) {
          setNotice(resolveGitHubStatusNotice(summary));
        }
      } catch {
        // A missing status response is not evidence of a GitHub outage. Keep
        // the most recent known state and quietly try again on the next tick.
      } finally {
        activeRequest = undefined;
        if (!cancelled) {
          nextRefresh = window.setTimeout(refresh, GITHUB_STATUS_POLL_INTERVAL_MS);
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      activeRequest?.abort();
      if (nextRefresh !== undefined) window.clearTimeout(nextRefresh);
    };
  }, []);

  const openGitHubStatus = useCallback(() => {
    void readLocalApi()
      ?.shell.openExternal(GITHUB_STATUS_PAGE_URL)
      .catch(() => undefined);
  }, []);

  if (!notice) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${notice.label}. ${notice.description}. Open GitHub Status.`}
            className={cn(
              "flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-xs font-medium transition-colors",
              notice.tone === "error"
                ? "bg-destructive/12 text-destructive hover:bg-destructive/18"
                : "bg-warning/12 text-warning hover:bg-warning/18",
            )}
            onClick={openGitHubStatus}
          >
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            <span className="truncate">{notice.label}</span>
            <ExternalLinkIcon className="ml-auto size-3 shrink-0 opacity-70" />
          </button>
        }
      />
      <TooltipPopup
        align="start"
        side="top"
        className="max-w-none [&_[data-slot=tooltip-viewport]]:p-0"
      >
        <GitHubStatusTooltip notice={notice} />
      </TooltipPopup>
    </Tooltip>
  );
}
