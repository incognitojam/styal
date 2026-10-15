import type { PullRequestMergeIntent } from "@t3tools/shared/threadPullRequests";

import type { PullRequestGlyphIcon } from "./pullRequestIcons";

/** Keep the existing PR/stack glyph and color; the filled corner dot adds merge intent. */
export function PullRequestMergeIntentIcon({
  Icon,
  mergeIntent,
}: {
  Icon: PullRequestGlyphIcon;
  mergeIntent?: PullRequestMergeIntent | undefined;
}) {
  return (
    <span aria-hidden className="relative inline-flex size-3 shrink-0">
      <Icon className="size-3" />
      {mergeIntent ? (
        <span className="absolute -top-0.5 -right-0.5 size-1 rounded-full bg-current outline-1 outline-background" />
      ) : null}
    </span>
  );
}
