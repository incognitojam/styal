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
import type { PullRequestCheck } from "@t3tools/contracts";
import { ArrowUpRightIcon, CircleDashedIcon, CircleDotIcon, HammerIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

import { Button } from "../ui/button";
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

/** The tab bar's at-a-glance result doubles as the shortest route into the checks themselves. */
export function PullRequestChecksNavButton({
  checks,
  onSelect,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  onSelect: () => void;
}) {
  const summary = summarizePullRequestChecks(checks);
  const state = pullRequestChecksState(checks);
  const presentation = state === null ? null : pullRequestChecksStatePresentation(state);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open checks: ${summary}`}
      className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {presentation ? (
        <presentation.Icon
          aria-hidden
          className={cn("size-3.5 shrink-0", presentation.toneClassName)}
        />
      ) : (
        <CircleDotIcon aria-hidden className="size-3.5 shrink-0" />
      )}
      <span>{summary}</span>
    </button>
  );
}

export function PullRequestChecksTab({
  checks,
  pendingFinding,
  fixCheckLabel = "Fix",
  onFixFinding,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  /** The hand-off currently preparing, if any, so only the check it belongs to says so. */
  pendingFinding?: string | null;
  fixCheckLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
}) {
  const state = pullRequestChecksState(checks);
  // Null for a set nobody can call passed or failed — every run skipped, say. The list still
  // reads, but there is no verdict to head it with.
  const rollup = state === null ? null : pullRequestChecksStatePresentation(state);
  const handoffPending = pendingFinding !== null && pendingFinding !== undefined;
  // A host can report the same named run more than once and checks carry no id. Keep the
  // occurrence beside the host-provided fields so repeated rows still receive distinct keys.
  const keyOccurrences = new Map<string, number>();

  const openCheck = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <div className="h-full overflow-y-auto">
      {rollup ? (
        // The verdict rides the top of the scroll box the way the summary's section headings do,
        // so a long list of runs never scrolls its own answer out of sight.
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-background px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{rollup.label}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
            <rollup.Icon aria-hidden className={cn("size-3.5 shrink-0", rollup.toneClassName)} />
            {summarizePullRequestChecks(checks)}
          </span>
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
                <span className="min-w-0 flex-1 truncate" title={check.description ?? check.name}>
                  {check.name}
                </span>
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
                  <div className={rowClassName}>{body}</div>
                ) : (
                  <button
                    type="button"
                    onClick={() => openCheck(check.url ?? "")}
                    title={`Open ${check.name} on the host`}
                    className={cn(
                      rowClassName,
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    {body}
                    {/* The one mark of a row that leads somewhere. Kept quiet until the row is
                        pointed at or focused, so a green list stays a green list. */}
                    <ArrowUpRightIcon
                      aria-hidden
                      className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
                    />
                  </button>
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
