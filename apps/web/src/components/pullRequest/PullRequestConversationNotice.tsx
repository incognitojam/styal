import type { PullRequestActivity } from "@t3tools/contracts";

import { Button } from "../ui/button";

export function PullRequestConversationNotice({
  activity,
  onRetry,
}: {
  activity: Pick<PullRequestActivity, "commentsTruncated" | "commentsUnavailable">;
  onRetry: () => void;
}) {
  if (!activity.commentsUnavailable && !activity.commentsTruncated) return null;

  return (
    <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
      <p>
        {activity.commentsUnavailable
          ? "Some review comments could not be loaded. Retry or open the pull request on the host to read the full conversation."
          : "Some comments are not shown here. Open the pull request on the host to read the full conversation."}
      </p>
      {activity.commentsUnavailable ? (
        <Button size="xs" variant="outline" className="mt-2" onClick={onRetry}>
          Retry comments
        </Button>
      ) : null}
    </div>
  );
}
