import type { PullRequestMergeIntent } from "@t3tools/shared/threadPullRequests";
import { cn } from "~/lib/utils";

import { PULL_REQUEST_STATE_PRESENTATION, type PullRequestGlyphIcon } from "./pullRequestIcons";

/** Keep the existing PR/stack glyph and color; a merge-violet corner dot adds merge intent. */
export function PullRequestMergeIntentIcon({
  Icon,
  mergeIntent,
  className,
}: {
  Icon: PullRequestGlyphIcon;
  mergeIntent?: PullRequestMergeIntent | undefined;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-3 shrink-0", className)}>
      <Icon className="size-full" />
      {mergeIntent ? (
        <span
          className={cn(
            "absolute -top-0.75 -right-0.75 size-1.5 rounded-full border border-background bg-current",
            PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
          )}
        />
      ) : null}
    </span>
  );
}
