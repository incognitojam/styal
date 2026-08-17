/**
 * Every check the host reported for one pull request, as a tab of its own.
 *
 * It used to be a fold under the summary, where it sat between the description and the
 * conversation and was scrolled past more often than it was read. A tab makes the answer to
 * "is this green?" one press away wherever the reader is, and gives the list room to say what
 * it knows: the rollup rides the top of the scroll box, and the runs read beneath it.
 *
 * Deliberately hook-free — it draws what the detail already holds, so the panel keeps it mounted
 * behind the other tabs for nothing.
 */
import type { PullRequestCheck, PullRequestMergeReadiness } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  HammerIcon,
  ShieldAlertIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import {
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestChecksState,
  pullRequestChecksStatePresentation,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";

/** A check the reader can act on: the two outcomes that leave something to reproduce. */
function isFailing(check: PullRequestCheck): boolean {
  return check.status === "failure" || check.status === "cancelled";
}

const MERGE_POLICY_PRESENTATION = {
  ready: {
    label: "Ready to merge",
    compactLabel: "Ready",
    Icon: CircleCheckIcon,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  blocked: {
    label: "Merge blocked",
    compactLabel: "Merge blocked",
    Icon: ShieldAlertIcon,
    toneClassName: "text-amber-600 dark:text-amber-400/90",
  },
} as const;

export function pullRequestMergeVerdict({
  checks,
  mergeReadiness,
  compact = false,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  mergeReadiness?: PullRequestMergeReadiness | undefined;
  compact?: boolean;
}) {
  const checksSummary = summarizePullRequestChecks(checks);
  if (mergeReadiness !== "ready" && mergeReadiness !== "blocked") {
    return { policy: null, label: checksSummary, health: null } as const;
  }

  const presentation = MERGE_POLICY_PRESENTATION[mergeReadiness];
  const label = compact ? presentation.compactLabel : presentation.label;
  const allPassed = checks.every((check) => check.status === "success");
  const health = allPassed
    ? null
    : compact
      ? checksSummary.replace(/^(\d+) of \d+ /, "$1 ")
      : checksSummary;
  return {
    policy: mergeReadiness,
    label,
    Icon: presentation.Icon,
    toneClassName: presentation.toneClassName,
    health,
  } as const;
}

/** The tab bar's at-a-glance result doubles as the shortest route into the checks themselves. */
export function PullRequestChecksNavButton({
  checks,
  mergeReadiness,
  onSelect,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  /** The host's repository-policy-aware merge verdict, where it exposes one. */
  mergeReadiness?: PullRequestMergeReadiness | undefined;
  onSelect: () => void;
}) {
  const verdict = pullRequestMergeVerdict({ checks, mergeReadiness });
  const state = pullRequestChecksState(checks);
  const checksPresentation = state === null ? null : pullRequestChecksStatePresentation(state);
  const Icon = verdict.policy === null ? (checksPresentation?.Icon ?? CircleDotIcon) : verdict.Icon;
  const toneClassName =
    verdict.policy === null ? checksPresentation?.toneClassName : verdict.toneClassName;
  const speech = verdict.health === null ? verdict.label : `${verdict.label} · ${verdict.health}`;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open checks: ${speech}`}
      className="ml-auto inline-flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden className={cn("size-3.5 shrink-0", toneClassName)} />
      <span className={cn("min-w-0 truncate", verdict.policy !== null && "font-medium")}>
        {verdict.label}
      </span>
      {verdict.health === null ? null : (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/50">
            ·
          </span>
          {checksPresentation === null ? null : (
            <checksPresentation.Icon
              aria-hidden
              className={cn("size-3.5 shrink-0", checksPresentation.toneClassName)}
            />
          )}
          <span className="shrink-0 tabular-nums">{verdict.health}</span>
        </>
      )}
    </button>
  );
}

export function PullRequestChecksTab({
  checks,
  mergeReadiness,
  pendingFinding,
  fixCheckLabel = "Fix",
  onFixFinding,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  /** The host's repository-policy-aware merge verdict, where it exposes one. */
  mergeReadiness?: PullRequestMergeReadiness | undefined;
  /** The hand-off currently preparing, if any, so only the check it belongs to says so. */
  pendingFinding?: string | null;
  fixCheckLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
}) {
  const state = pullRequestChecksState(checks);
  // Null for a set nobody can call passed or failed — every run skipped, say. The list still
  // reads, but there is no verdict to head it with.
  const rollup = state === null ? null : pullRequestChecksStatePresentation(state);
  const mergePresentation =
    mergeReadiness === undefined
      ? null
      : mergeReadiness === "ready"
        ? {
            label: "Ready to merge",
            Icon: CircleCheckIcon,
            toneClassName: "text-emerald-600 dark:text-emerald-300/90",
          }
        : mergeReadiness === "blocked"
          ? {
              label: "Merge blocked by repository requirements",
              Icon: ShieldAlertIcon,
              toneClassName: "text-amber-600 dark:text-amber-400/90",
            }
          : {
              label: "Merge status unavailable",
              Icon: CircleHelpIcon,
              toneClassName: "text-muted-foreground",
            };
  const requiredCount = checks.filter((check) => check.required === true).length;
  const handoffPending = pendingFinding !== null && pendingFinding !== undefined;
  // A host can report the same named run more than once and checks carry no id. Keep the
  // occurrence beside the host-provided fields so repeated rows still receive distinct keys.
  const keyOccurrences = new Map<string, number>();

  const openCheck = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <div className="h-full overflow-y-auto">
      {mergePresentation || rollup ? (
        // The verdict rides the top of the scroll box the way the summary's section headings do,
        // so a long list of runs never scrolls its own answer out of sight.
        <div className="sticky top-0 z-10 space-y-1 bg-background px-4 py-2.5">
          {mergePresentation ? (
            <div className="flex items-center gap-2 text-sm font-medium">
              <mergePresentation.Icon
                aria-hidden
                className={cn("size-3.5 shrink-0", mergePresentation.toneClassName)}
              />
              <span className="min-w-0 truncate">{mergePresentation.label}</span>
            </div>
          ) : null}
          {rollup ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {rollup.label}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                <rollup.Icon
                  aria-hidden
                  className={cn("size-3.5 shrink-0", rollup.toneClassName)}
                />
                {requiredCount > 0 ? `${requiredCount} required · ` : null}
                {summarizePullRequestChecks(checks)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {checks.length === 0 ? (
        // The same words the fold under the summary used, given the room a tab has: a reader who
        // opened Checks asked a question, and "nothing here" on its own does not answer it.
        <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <CircleDashedIcon aria-hidden className="size-5 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">No checks reported.</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Runs appear here as soon as the host reports one for this branch.
          </p>
        </div>
      ) : (
        <ul className="space-y-0.5 px-4 py-3">
          {checks.map((check) => {
            const finding = { kind: "check", check } as const;
            const failing = isFailing(check);
            const keyBase = `${check.name}:${check.url ?? ""}:${check.status}:${check.description ?? ""}`;
            const occurrence = keyOccurrences.get(keyBase) ?? 0;
            keyOccurrences.set(keyBase, occurrence + 1);
            const rowClassName =
              "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs";
            const body = (
              <>
                <PullRequestCheckStatusIcon status={check.status} />
                <span className="min-w-0 flex-1 truncate">{check.name}</span>
                {check.required === true ? (
                  <Badge size="sm" variant="warning" className="font-normal">
                    Required
                  </Badge>
                ) : null}
                <span className="shrink-0 text-muted-foreground">
                  {pullRequestCheckStatusLabel(check.status)}
                </span>
              </>
            );
            return (
              <li
                key={`${keyBase}:${occurrence}`}
                className="group flex items-center gap-1 rounded-md pr-1 hover:bg-accent/60"
              >
                {check.url === null ? (
                  // Nothing to open, so nothing to press: a row the host gave no link for stays
                  // out of the tab order rather than sitting in it as a dead button.
                  <Tooltip>
                    <TooltipTrigger render={<div className={rowClassName} />}>
                      {body}
                    </TooltipTrigger>
                    <TooltipPopup>{check.description ?? check.name}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`Open ${check.name} on the host`}
                          onClick={() => openCheck(check.url ?? "")}
                          className={cn(
                            rowClassName,
                            "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          )}
                        />
                      }
                    >
                      {body}
                      {/* The one mark of a row that leads somewhere. Kept quiet until the row is
                          pointed at or focused, so a green list stays a green list. */}
                      <ArrowUpRightIcon
                        aria-hidden
                        className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
                      />
                    </TooltipTrigger>
                    <TooltipPopup>
                      {check.description ?? `Open ${check.name} on the host`}
                    </TooltipPopup>
                  </Tooltip>
                )}
                {/* Only where there is something to fix. A passing check has no failure to
                    reproduce, and the button would be an invitation to waste a thread. */}
                {onFixFinding && failing ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    disabled={handoffPending}
                    onClick={() => onFixFinding(finding)}
                  >
                    <HammerIcon className="size-3" />
                    {pendingFinding === pullRequestFindingKey(finding)
                      ? "Preparing..."
                      : fixCheckLabel}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
