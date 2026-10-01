import type { PullRequestActivity } from "@t3tools/contracts";

export function PullRequestConversationNotice({
  activity,
}: {
  activity: Pick<PullRequestActivity, "commentsTruncated" | "commentsUnavailable">;
}) {
  if (!activity.commentsUnavailable && !activity.commentsTruncated) return null;

  return (
    <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
      <p>
        {activity.commentsUnavailable
          ? "Some review comments could not be loaded. Choose Refresh from the pull request menu to try again, or open it on the host to read the full conversation."
          : "Some comments are not shown here. Open the pull request on the host to read the full conversation."}
      </p>
    </div>
  );
}
