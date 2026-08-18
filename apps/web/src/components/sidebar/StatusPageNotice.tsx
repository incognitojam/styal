import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentType, type SVGProps } from "react";

import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import {
  isStatusPageSummary,
  type StatusPageNotice as StatusPageNoticeView,
} from "../../statusPage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const STATUS_POLL_INTERVAL_MS = 60_000;
const STATUS_COMPONENTS_TIMEOUT_MS = 5_000;

type StatusPageNoticeResolver = (
  summary: unknown,
  components?: unknown,
) => StatusPageNoticeView | null;

interface StatusPageNoticeProps {
  readonly componentsUrl?: string;
  readonly enabled: boolean;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly pageName: string;
  readonly pageUrl: string;
  readonly resolveNotice: StatusPageNoticeResolver;
  readonly summaryUrl: string;
}

interface StatusPageNoticeFetchOptions {
  readonly componentsUrl: string | undefined;
  readonly resolveNotice: StatusPageNoticeResolver;
  readonly signal: AbortSignal;
  readonly summaryUrl: string;
}

interface StatusPageNoticeLoad {
  readonly notice: StatusPageNoticeView | null;
  readonly enrichment: Promise<StatusPageNoticeView | null | undefined> | undefined;
}

function fetchOptionalStatusPageJson(url: string, signal: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), STATUS_COMPONENTS_TIMEOUT_MS);

  return fetch(url, {
    headers: { Accept: "application/json" },
    signal: controller.signal,
  })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch((): undefined => undefined)
    .finally(() => {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    });
}

/** Returns undefined when the summary is unusable, preserving the last known notice. */
export async function fetchStatusPageNotice({
  componentsUrl,
  resolveNotice,
  signal,
  summaryUrl,
}: StatusPageNoticeFetchOptions): Promise<StatusPageNoticeLoad | undefined> {
  const response = await fetch(summaryUrl, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) return undefined;

  const summary: unknown = await response.json();
  if (!isStatusPageSummary(summary)) return undefined;
  const notice = resolveNotice(summary);

  return {
    notice,
    enrichment: componentsUrl
      ? fetchOptionalStatusPageJson(componentsUrl, signal).then((components) =>
          components === undefined ? undefined : resolveNotice(summary, components),
        )
      : undefined,
  };
}

function componentKey(name: string): string {
  return name.trim().toLowerCase();
}

function StatusPageTooltip({
  icon: StatusIcon,
  notice,
  pageName,
}: {
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly notice: StatusPageNoticeView;
  readonly pageName: string;
}) {
  // Components that already appear as their own status row below. Repeating them
  // inside each incident is the redundancy this tooltip is meant to avoid.
  const listedComponents = new Set(
    notice.affectedComponents.map((component) => componentKey(component.name)),
  );
  const incidents = notice.activeIncidents.map((incident) => ({
    incident,
    // Kept for incidents whose components still report operational (for example a
    // monitoring incident), where this is the only place the scope is visible.
    unlistedComponents: incident.affectedComponents.filter(
      (name) => !listedComponents.has(componentKey(name)),
    ),
  }));
  const hasDetail = incidents.length > 0 || notice.affectedComponents.length > 0;

  return (
    <div className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-[var(--floating-content-inset)] text-left">
      <div className="flex min-w-0 items-start gap-2 font-medium text-foreground">
        <StatusIcon aria-hidden className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">
          <span className="text-muted-foreground">{pageName}</span> · {notice.description}
        </span>
      </div>
      {hasDetail ? (
        <div className="mt-2 grid min-w-0 gap-2 border-t border-border/60 pt-2">
          {incidents.map(({ incident, unlistedComponents }) => (
            <div className="grid min-w-0 gap-1" key={incident.name}>
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 break-words text-foreground">{incident.name}</span>
                <span className="max-w-[45%] shrink-0 break-words text-right text-muted-foreground">
                  {incident.statusLabel}
                </span>
              </div>
              {unlistedComponents.length > 0 ? (
                <ul className="grid min-w-0 gap-0.5 border-l border-border/60 pl-2 text-muted-foreground">
                  {unlistedComponents.map((name) => (
                    <li className="min-w-0 break-words" key={name}>
                      {name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
          {notice.affectedComponents.length > 0 ? (
            <ul className="grid min-w-0 gap-1">
              {notice.affectedComponents.map((component) => (
                <li
                  className="flex min-w-0 items-baseline justify-between gap-3"
                  key={component.name}
                >
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">
                    {component.name}
                  </span>
                  <span className="max-w-[45%] shrink-0 break-words text-right text-foreground/80">
                    {component.statusLabel}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StatusPageNotice({
  componentsUrl,
  enabled,
  icon: Icon,
  pageName,
  pageUrl,
  resolveNotice,
  summaryUrl,
}: StatusPageNoticeProps) {
  const [notice, setNotice] = useState<StatusPageNoticeView | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let nextRefresh: number | undefined;
    let activeRequest: AbortController | undefined;

    const refresh = async () => {
      const request = new AbortController();
      activeRequest = request;
      let enrichmentStarted = false;
      try {
        const loaded = await fetchStatusPageNotice({
          componentsUrl,
          resolveNotice,
          signal: request.signal,
          summaryUrl,
        });
        if (!cancelled && loaded !== undefined) {
          setNotice(loaded.notice);
          if (loaded.enrichment) {
            enrichmentStarted = true;
            void loaded.enrichment
              .then((enrichedNotice) => {
                if (!cancelled && enrichedNotice !== undefined) {
                  setNotice(enrichedNotice);
                }
              })
              .finally(() => {
                if (activeRequest === request) activeRequest = undefined;
              });
          }
        }
      } catch {
        // A missing status response is not evidence of an outage. Keep the
        // most recent known state and quietly try again on the next tick.
      } finally {
        if (!enrichmentStarted && activeRequest === request) activeRequest = undefined;
        if (!cancelled) {
          nextRefresh = window.setTimeout(refresh, STATUS_POLL_INTERVAL_MS);
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      activeRequest?.abort();
      if (nextRefresh !== undefined) window.clearTimeout(nextRefresh);
    };
  }, [componentsUrl, enabled, resolveNotice, summaryUrl]);

  const openStatusPage = useCallback(() => {
    void readLocalApi()
      ?.shell.openExternal(pageUrl)
      .catch(() => undefined);
  }, [pageUrl]);

  if (!enabled || !notice) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${notice.label}. ${notice.description}. Open ${pageName} Status.`}
            className={cn(
              "flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
              notice.tone === "error"
                ? "bg-destructive/12 text-destructive-foreground hover:bg-destructive/18"
                : "bg-warning/12 text-warning-foreground hover:bg-warning/18",
            )}
            onClick={openStatusPage}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{notice.label}</span>
            <ExternalLinkIcon className="size-3 shrink-0 opacity-70" />
          </button>
        }
      />
      <TooltipPopup
        align="start"
        side="top"
        className="max-w-none [&_[data-slot=tooltip-viewport]]:p-0"
      >
        <StatusPageTooltip icon={Icon} notice={notice} pageName={pageName} />
      </TooltipPopup>
    </Tooltip>
  );
}
