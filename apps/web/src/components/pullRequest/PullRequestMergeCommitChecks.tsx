import { mergeCommitChecksSummary } from "@t3tools/client-runtime/pull-request-merge-commit";
import type { EnvironmentId, PullRequestMergeCommit } from "@t3tools/contracts";
import { CircleHelpIcon, CircleDotIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { reportForkClientUsage } from "~/forkClientUsage";
import { cn } from "~/lib/utils";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestChecksTab } from "./PullRequestChecksTab";
import { pullRequestChecksStatePresentation } from "./pullRequestPresentation";

export type PullRequestChecksScope = "merge-commit" | "pull-request";

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
  headSha,
  environmentId,
  scope,
  onScopeChange,
  children,
}: {
  commit: PullRequestMergeCommit | null | undefined;
  headSha: string | null;
  environmentId?: EnvironmentId | undefined;
  scope: PullRequestChecksScope;
  onScopeChange: (scope: PullRequestChecksScope) => void;
  children: ReactNode;
}) {
  const openLink = useOpenLink(null);
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
  if (commit === undefined) return children;
  const mergeSelected = scope === "merge-commit";
  const sha = mergeSelected ? commit?.oid : headSha;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        <ToggleGroup
          aria-label="Checks for"
          size="segmented"
          variant="segmented"
          value={[scope]}
          onValueChange={(next) => {
            if (next[0] === "merge-commit" || next[0] === "pull-request") onScopeChange(next[0]);
          }}
        >
          <Toggle value="merge-commit">Merge commit</Toggle>
          <Toggle value="pull-request">Pull request</Toggle>
        </ToggleGroup>
        {sha ? (
          <Tooltip>
            <TooltipTrigger
              render={
                mergeSelected && commit ? (
                  <a
                    href={commit.url}
                    aria-label={`Open merge commit ${commit.oid.slice(0, 7)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      open(commit.url, "open_commit");
                    }}
                    className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                  />
                ) : (
                  <span className="font-mono text-xs text-muted-foreground" />
                )
              }
            >
              {sha.slice(0, 7)}
            </TooltipTrigger>
            <TooltipPopup>{sha}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <section
        aria-label={mergeSelected ? "Merge commit checks" : "Pull request checks"}
        className="min-h-0 flex-1"
      >
        {!mergeSelected ? (
          children
        ) : commit === null || commit.checks === null ? (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
            <CircleHelpIcon aria-hidden className="size-3.5" />
            {commit === null ? "Merge commit unavailable" : "Checks unavailable"}
          </div>
        ) : (
          <PullRequestChecksTab
            checks={commit.checks}
            onOpenCheck={(url) => open(url, "open_check")}
          />
        )}
      </section>
    </div>
  );
}
