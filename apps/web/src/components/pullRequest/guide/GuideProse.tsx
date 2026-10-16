import type { EnvironmentId, PullRequestDetailView } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import { cn } from "~/lib/utils";

import { PullRequestMarkdown } from "../PullRequestMarkdown";

/** Where the guide's prose renders from: the pull request's environment and detail. */
export const GuideProseContext = createContext<{
  readonly environmentId: EnvironmentId;
  readonly detail: PullRequestDetailView;
} | null>(null);

export function GuideProse({
  text,
  plain = false,
  className,
}: {
  text: string;
  plain?: boolean;
  className?: string;
}) {
  const context = useContext(GuideProseContext);
  if (plain || context === null) return text;
  return (
    <PullRequestMarkdown
      text={text}
      detail={context.detail}
      environmentId={context.environmentId}
      className={cn("space-y-0 [&_.chat-markdown]:text-inherit", className)}
    />
  );
}
