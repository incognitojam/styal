import type { PullRequestMergeIntent } from "@t3tools/shared/threadPullRequests";
import { cn } from "~/lib/utils";

import type { PullRequestGlyphIcon } from "./pullRequestIcons";

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
        <span className="absolute -top-0.5 -right-0.5 size-1 rounded-full bg-violet-600 outline-1 outline-background dark:bg-violet-300" />
      ) : null}
    </span>
  );
}
