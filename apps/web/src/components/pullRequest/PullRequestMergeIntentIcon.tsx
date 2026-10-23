import type { PullRequestMergeIntent } from "@t3tools/shared/threadPullRequests";
import { cn } from "~/lib/utils";

import type { PullRequestGlyphIcon } from "./pullRequestIcons";

/** Keep the existing PR/stack glyph and color; the filled corner dot adds merge intent. */
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
        <span className="absolute -top-0.5 -right-0.5 size-1 rounded-full bg-current outline-1 outline-background" />
      ) : null}
    </span>
  );
}
