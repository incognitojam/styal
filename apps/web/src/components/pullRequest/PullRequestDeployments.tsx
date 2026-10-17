import type { PullRequestDeployment, ScopedThreadRef } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  CircleXIcon,
  Clock3Icon,
} from "lucide-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PULL_REQUEST_DEPLOYMENT_PAGE,
  isFailedPullRequestDeployment,
  orderPullRequestDeployments,
} from "./pullRequestDeployments.logic";

const RUNNING_TONE = "text-amber-600 dark:text-amber-400/90";

const STATUS = {
  success: {
    label: "Deployed",
    Icon: CircleCheckIcon,
    tone: "text-emerald-600 dark:text-emerald-300/90",
  },
  failure: { label: "Failed", Icon: CircleXIcon, tone: "text-destructive" },
  error: { label: "Error", Icon: CircleXIcon, tone: "text-destructive" },
  "in-progress": { label: "Deploying", Icon: Clock3Icon, tone: RUNNING_TONE },
  queued: { label: "Queued", Icon: Clock3Icon, tone: RUNNING_TONE },
  pending: { label: "Pending", Icon: Clock3Icon, tone: RUNNING_TONE },
  waiting: { label: "Waiting", Icon: Clock3Icon, tone: RUNNING_TONE },
  inactive: { label: "Inactive", Icon: CircleMinusIcon, tone: "text-muted-foreground" },
  unknown: { label: "Unknown", Icon: CircleHelpIcon, tone: "text-muted-foreground" },
} as const;

export function PullRequestDeployments({
  deployments,
  truncated,
  threadRef,
  headSha,
}: {
  deployments: ReadonlyArray<PullRequestDeployment>;
  truncated: boolean;
  threadRef: ScopedThreadRef | null;
  headSha?: string | undefined;
}) {
  const openLink = useOpenLink(threadRef);
  const [showAll, setShowAll] = useState(false);
  const open = (url: string) => {
    void openLink(url).catch((error: unknown) => {
      console.error(error);
      toastManager.add({ type: "error", title: "Unable to open deployment" });
    });
  };
  const ordered = orderPullRequestDeployments(deployments);
  const canCollapse = ordered.length > PULL_REQUEST_DEPLOYMENT_PAGE;
  const visible =
    showAll || !canCollapse ? ordered : ordered.slice(0, PULL_REQUEST_DEPLOYMENT_PAGE);

  return (
    <div className="rounded-lg border border-border/60">
      <ul className="divide-y divide-border/60 px-3">
        {visible.map((deployment) => {
          const { label, Icon, tone } = STATUS[deployment.status];
          const inactive = deployment.status === "inactive";
          const environmentUrl = inactive ? null : deployment.environmentUrl;
          const logUrl = deployment.logUrl;
          // The hash is only news when this is not the head the PR is showing.
          const olderCommit = headSha !== undefined && deployment.commitSha !== headSha;
          const showCommit = headSha === undefined || olderCommit;
          return (
            <li key={deployment.id} className="flex items-start gap-x-3 py-2">
              <Icon aria-hidden className={cn("mt-px size-4 shrink-0", tone)} />
              <div className="min-w-0 flex-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div
                        className={cn(
                          "truncate text-xs font-medium",
                          inactive && "text-muted-foreground",
                        )}
                      />
                    }
                  >
                    {deployment.environment}
                  </TooltipTrigger>
                  <TooltipPopup>{deployment.environment}</TooltipPopup>
                </Tooltip>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-2xs text-muted-foreground">
                  <span>{label}</span>
                  {showCommit ? (
                    <>
                      <span aria-hidden>·</span>
                      <Tooltip>
                        <TooltipTrigger render={<span className="font-mono" />}>
                          {deployment.commitSha.slice(0, 7)}
                        </TooltipTrigger>
                        <TooltipPopup>
                          {olderCommit ? "Older commit" : "Commit"} {deployment.commitSha}
                        </TooltipPopup>
                      </Tooltip>
                    </>
                  ) : null}
                  <span aria-hidden>·</span>
                  <Tooltip>
                    <TooltipTrigger render={<time dateTime={deployment.updatedAt} />}>
                      {formatRelativeTimeLabel(deployment.updatedAt)}
                    </TooltipTrigger>
                    <TooltipPopup>
                      Updated {new Date(deployment.updatedAt).toLocaleString()}
                    </TooltipPopup>
                  </Tooltip>
                </div>
                {isFailedPullRequestDeployment(deployment) && deployment.description ? (
                  <p className="mt-1 text-2xs wrap-break-word text-muted-foreground">
                    {deployment.description}
                  </p>
                ) : null}
              </div>
              <div className="flex h-4.5 shrink-0 items-center gap-1">
                {logUrl ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => open(logUrl)}
                    aria-label={`View deployment logs for ${deployment.environment}`}
                  >
                    Logs
                  </Button>
                ) : null}
                {environmentUrl ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => open(environmentUrl)}
                    aria-label={`Open ${deployment.environment}`}
                  >
                    Open
                    <ArrowUpRightIcon aria-hidden />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {canCollapse || truncated ? (
        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5">
          {truncated ? (
            <p className="min-w-0 flex-1 text-2xs text-muted-foreground/80">
              Environments not deployed recently may be missing.
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {canCollapse ? (
            <Button
              variant="ghost-muted"
              size="xs"
              aria-expanded={showAll}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? "Show less" : `Show all ${ordered.length}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
