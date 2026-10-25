import { mergeCommitChecksSummary } from "@t3tools/client-runtime/pull-request-merge-commit";
import type { EnvironmentId, PullRequestMergeCommit } from "@t3tools/contracts";
import { CircleHelpIcon, CircleDotIcon } from "lucide-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { reportForkClientUsage } from "~/forkClientUsage";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";

export function PullRequestMergeCommitStatus({
  commit,
  onSelect,
}: {
  commit: PullRequestMergeCommit | null;
  onSelect: () => void;
}) {
  const summary = mergeCommitChecksSummary(commit);
  const presentation =
    summary.state === null ? null : pullRequestChecksStatePresentation(summary.state);
  const Icon =
    presentation?.Icon ??
    (commit?.checks === null || commit === null ? CircleHelpIcon : CircleDotIcon);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      aria-label={`Merge commit: ${summary.label}`}
    >
      <Icon aria-hidden className={cn("size-3.5 shrink-0", presentation?.toneClassName)} />
      <span className="truncate">
        {commit === null ? summary.label : `Merge commit · ${summary.label}`}
      </span>
    </button>
  );
}

export function PullRequestMergeCommitChecks({
  commit,
  environmentId,
  expanded = false,
}: {
  commit: PullRequestMergeCommit | null;
  environmentId?: EnvironmentId | undefined;
  expanded?: boolean;
}) {
  const [showChecks, setShowChecks] = useState(expanded);
  const openLink = useOpenLink(null);
  const summary = mergeCommitChecksSummary(commit);
  const keyOccurrences = new Map<string, number>();
  const open = (url: string, action: "open_commit" | "open_check") => {
    void openLink(url).then(
      () =>
        reportForkClientUsage(environmentId, {
          feature: "pull-request-merge-commit-checks",
          action,
          outcome: "success",
        }),
      () =>
        reportForkClientUsage(environmentId, {
          feature: "pull-request-merge-commit-checks",
          action,
          outcome: "failure",
        }),
    );
  };
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium">{commit === null ? summary.label : "Merge commit"}</span>
        {commit ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <a
                  href={commit.url}
                  onClick={(event) => {
                    event.preventDefault();
                    open(commit.url, "open_commit");
                  }}
                  className="font-mono text-muted-foreground hover:underline"
                />
              }
            >
              {commit.oid.slice(0, 7)}
            </TooltipTrigger>
            <TooltipPopup>{commit.oid}</TooltipPopup>
          </Tooltip>
        ) : null}
        {commit ? (
          <span className="min-w-0 flex-1 text-muted-foreground">{summary.label}</span>
        ) : null}
        {!expanded && commit?.checks && commit.checks.length > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={showChecks}
            onClick={() => setShowChecks(!showChecks)}
          >
            {showChecks ? "Hide details" : "Details"}
          </Button>
        ) : null}
      </div>
      {showChecks && commit?.checks && commit.checks.length > 0 ? (
        <ul className="mt-2 divide-y divide-border/50">
          {commit.checks.map((check) => {
            const keyBase = `${check.name}:${check.url}:${check.status}:${check.description}`;
            const occurrence = keyOccurrences.get(keyBase) ?? 0;
            keyOccurrences.set(keyBase, occurrence + 1);
            return (
              <li key={`${keyBase}:${occurrence}`} className="flex items-center gap-2 py-2 text-xs">
                <PullRequestCheckStatusIcon status={check.status} />
                <div className="min-w-0 flex-1">
                  <p className="truncate">{check.name}</p>
                  {check.description ? (
                    <p className="truncate text-muted-foreground">{check.description}</p>
                  ) : null}
                </div>
                <span className="text-muted-foreground">{pullRequestCheckStatusLabel(check)}</span>
                {check.url ? (
                  <a
                    className="text-muted-foreground hover:underline"
                    href={check.url}
                    onClick={(event) => {
                      event.preventDefault();
                      if (check.url) open(check.url, "open_check");
                    }}
                  >
                    Details
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
