import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolveThreadListStatus } from "@t3tools/client-runtime/state/thread-list-status";
import type { ClientSettings } from "@t3tools/contracts";
import { threadUsageSummary } from "@t3tools/shared/turnUsage";
import { ChartNoAxesColumnIcon, ListIcon, MessageSquareTextIcon, MonitorIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useDelegatedUnderParent, useThreadShellsForProjectRefs } from "../../state/entities";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { projectCardTotals } from "./SidebarProjectCard.logic";

const selectUsageEnabled = (settings: ClientSettings) => settings.turnUsageEnabled;
const selectUsageFigure = (settings: ClientSettings) => settings.turnUsageFigure;

const CHAT_STATUS: Record<ReturnType<typeof resolveThreadListStatus>, string> = {
  approval: "Needs your approval",
  input: "Waiting for your answer",
  request: "A guest is waiting on you",
  preparing: "Starting",
  working: "Working",
  waiting: "Waiting",
  failed: "Failed",
  limited: "Usage limit reached",
  ready: "Idle",
};

function Row(props: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 flex shrink-0">{props.icon}</span>
      <div className="min-w-0 flex-1 text-foreground/75">{props.children}</div>
    </div>
  );
}

const iconClass = "size-3 shrink-0 stroke-muted-foreground";

/** Mounted only while open, so nothing here runs for a closed card. */
function SidebarProjectCardContent(props: {
  group: SidebarProjectSnapshot;
  /** undefined: project coordinators are off; null: on, with no chat yet. */
  chat: EnvironmentThreadShell | null | undefined;
}) {
  const { group, chat } = props;
  const usageEnabled = useClientSettings(selectUsageEnabled);
  const usageFigure = useClientSettings(selectUsageFigure);
  const threads = useThreadShellsForProjectRefs(
    group.memberProjects.map((member) => scopeProjectRef(member.environmentId, member.id)),
  );
  const { open, settled, working, needYou, openPullRequests, usage } = projectCardTotals(
    threads,
    chat ?? null,
    useDelegatedUnderParent(),
  );
  const machines = [
    ...new Set(group.memberProjects.map((member) => member.environmentLabel).filter(Boolean)),
  ];

  // With coordinators on, the header already shows working and needs-you counts.
  const threadParts = [
    `${open} open`,
    `${settled} settled`,
    ...(chat === undefined && working > 0 ? [`${working} working`] : []),
    ...(chat === undefined && needYou > 0
      ? [`${needYou} need${needYou === 1 ? "s" : ""} you`]
      : []),
  ];

  return (
    <ThreadHoverCard title={group.displayName}>
      {chat !== undefined ? (
        <Row icon={<MessageSquareTextIcon aria-hidden className={iconClass} />}>
          {chat === null ? (
            <>
              <div>No project chat yet</div>
              <div className="text-muted-foreground">Open the project to start one.</div>
            </>
          ) : (
            <>
              <div>Project chat · {CHAT_STATUS[resolveThreadListStatus(chat)]}</div>
              {(chat.openReportQuestionCount ?? 0) > 0 ? (
                <div className="text-muted-foreground">
                  {chat.openReportQuestionCount} question
                  {chat.openReportQuestionCount === 1 ? "" : "s"} from its threads
                </div>
              ) : null}
            </>
          )}
        </Row>
      ) : null}
      <Row icon={<ListIcon aria-hidden className={iconClass} />}>{threadParts.join(" · ")}</Row>
      {machines.length > 0 ? (
        <Row icon={<MonitorIcon aria-hidden className={iconClass} />}>
          <div className="truncate">{machines.join(", ")}</div>
        </Row>
      ) : null}
      {openPullRequests > 0 ? (
        <Row icon={<PullRequestGlyph.pullRequest aria-hidden className={iconClass} />}>
          {openPullRequests} open pull request{openPullRequests === 1 ? "" : "s"}
        </Row>
      ) : null}
      {usageEnabled && usage ? (
        <Row icon={<ChartNoAxesColumnIcon aria-hidden className={iconClass} />}>
          <span className="tabular-nums">{threadUsageSummary(usage, usageFigure)}</span>
        </Row>
      ) : null}
    </ThreadHoverCard>
  );
}

export function SidebarProjectCardPopup(props: {
  group: SidebarProjectSnapshot;
  chat: EnvironmentThreadShell | null | undefined;
}) {
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <SidebarProjectCardContent {...props} />
    </ThreadHoverCardPopup>
  );
}
