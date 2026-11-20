import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { coordinatorReports } from "@t3tools/client-runtime/coordinator-reports";
import {
  type CapturedSinceLastVisit,
  sinceLastVisitGroups,
  sinceLastVisitHistoryGap,
  sinceLastVisitLayout,
  sinceLastVisitReportLines,
  sinceLastVisitReportsKey,
  type SinceLastVisitGroup,
  sinceLastVisitMissingBefore,
  type SinceLastVisitLine,
  type SinceLastVisitSection,
} from "@t3tools/client-runtime/project-since-last-visit";
import type {
  CoordinatorReport,
  MessageId,
  ScopedThreadRef,
  TimestampFormat,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { CircleAlertIcon, CircleCheckIcon, FileTextIcon, HourglassIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { type MouseEvent, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useThreadHistory } from "../../state/entities";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp, formatRelativeTimeLabel } from "../../timestampFormat";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { InlineButton } from "../ui/button";

type ReportReference = {
  readonly messageId: string;
  readonly key: string;
  readonly version: number;
};

interface ChatReports {
  readonly key: string;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly createdAt: string;
    readonly report?: CoordinatorReport | undefined;
    readonly reportAnswer?: ReportReference | undefined;
  }>;
  readonly dismissals: ReadonlyArray<ReportReference>;
  readonly earliestLoadedAt: string | null;
}

const NO_CHAT_REPORTS: ChatReports = {
  key: "",
  messages: [],
  dismissals: [],
  earliestLoadedAt: null,
};

/**
 * The chat's reports, answers and dismissals, and where its loaded history starts. Held while
 * these stay the same, so a turn streaming in the chat does not re-render the card.
 */
const chatReportsAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey)!;
  let previous = NO_CHAT_REPORTS;
  return Atom.make((get): ChatReports => {
    const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection ?? null;
    if (projection === null) return (previous = NO_CHAT_REPORTS);
    let earliest: DateTime.Utc | null = null;
    const messages: ChatReports["messages"][number][] = [];
    for (const message of projection.messages) {
      if (earliest === null || DateTime.isLessThan(message.createdAt, earliest)) {
        earliest = message.createdAt;
      }
      if (!message.report && !message.reportAnswer) continue;
      messages.push({ ...message, createdAt: DateTime.formatIso(message.createdAt) });
    }
    const dismissals = projection.thread.reportDismissals ?? [];
    const earliestLoadedAt = earliest === null ? null : DateTime.formatIso(earliest);
    const key = sinceLastVisitReportsKey(earliestLoadedAt, messages, dismissals);
    if (key !== previous.key) previous = { key, messages, dismissals, earliestLoadedAt };
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`project-since-last-visit-reports:${threadKey}`));
});

const GROUP_LABEL: Record<SinceLastVisitGroup, string> = {
  failed: "Failed",
  reports: "Reports",
  pullRequests: "Pull requests",
  ended: "Ended a turn",
};

/**
 * What happened in the project between the user's last visit and this page view, from the
 * capture the page took when it opened. Reports come from the chat's loaded history.
 */
export function ProjectSinceLastVisit({
  chatRef,
  captured,
  onOpenReport,
}: {
  chatRef: ScopedThreadRef;
  captured: CapturedSinceLastVisit;
  onOpenReport: (messageId: MessageId) => void;
}) {
  const { window, threadLines } = captured;
  const chat = useAtomValue(chatReportsAtom(scopedThreadKey(chatRef)));
  const history = useThreadHistory(chatRef);
  const { timestampFormat } = useEnvironmentSettings(chatRef.environmentId);
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const navigate = useNavigate();
  const openPrLink = useOpenPrLink();
  const [expanded, setExpanded] = useState<ReadonlySet<SinceLastVisitGroup>>(new Set());

  const reports = coordinatorReports(chat.messages, chat.dismissals);
  const gap = sinceLastVisitHistoryGap(
    { hasMoreHistory: history.hasMoreHistory, earliestLoadedAt: chat.earliestLoadedAt },
    window,
  );
  const layout = sinceLastVisitLayout(
    sinceLastVisitGroups(threadLines, sinceLastVisitReportLines(reports, chat.dismissals, window)),
    expanded,
  );

  const sinceIso = new Date(window.since).toISOString();
  const sinceLabel = `${formatDayAwareTimestamp(sinceIso, timestampFormat, window.until)}, ${formatRelativeTimeLabel(sinceIso, window.until)}`;
  const time = (at: number) =>
    formatDayAwareTimestamp(new Date(at).toISOString(), timestampFormat, window.until);
  const loadEarlierControl = gap ? (
    <>
      {gap.loadedFrom === null
        ? "Earlier reports are in history"
        : `Reports before ${time(gap.loadedFrom)} are in earlier history`}
      {" · "}
      <InlineButton
        tone="muted"
        disabled={history.loading}
        onClick={() =>
          void loadEarlier({
            environmentId: chatRef.environmentId,
            input: { threadId: chatRef.threadId },
          })
        }
      >
        Load earlier
      </InlineButton>
    </>
  ) : null;

  const missingBefore = sinceLastVisitMissingBefore(captured);
  const unloadedNote =
    missingBefore === null ? null : `Changes before ${time(missingBefore)} may be missing.`;

  if (layout.total === 0) {
    return (
      <div
        data-testid="project-since-last-visit"
        className="flex items-center gap-3 py-1 text-muted-foreground text-xs before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
      >
        <span>
          Nothing new since your last visit, {formatRelativeTimeLabel(sinceIso, window.until)}
          {loadEarlierControl ? <> · {loadEarlierControl}</> : null}
          {unloadedNote ? <> · {unloadedNote}</> : null}
        </span>
      </div>
    );
  }

  const openThread = (line: SinceLastVisitLine) => {
    if (line.kind === "report") {
      onOpenReport(line.messageId as MessageId);
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(line.environmentId, line.threadId)),
    });
  };
  const openLine = (event: MouseEvent<HTMLButtonElement>, line: SinceLastVisitLine) => {
    if (line.kind !== "merged" && line.kind !== "opened") {
      openThread(line);
      return;
    }
    const threadRef = scopeThreadRef(line.environmentId, line.threadId);
    if (openPrLink(event, line.url, threadRef)) openThread(line);
  };
  const expand = (group: SinceLastVisitGroup) => setExpanded(new Set(expanded).add(group));

  return (
    <div
      data-testid="project-since-last-visit"
      className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs">
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">Since your last visit</span> · {sinceLabel}
        </span>
        <span className="shrink-0">{layout.total}</span>
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {layout.grouped ? (
          layout.sections.map((section) => (
            <SinceLastVisitSectionRows
              key={section.group}
              section={section}
              grouped
              time={time}
              timestampFormat={timestampFormat}
              onOpen={openLine}
              onExpand={() => expand(section.group)}
              footer={section.group === "reports" ? loadEarlierControl : null}
            />
          ))
        ) : (
          <SinceLastVisitSectionRows
            section={{
              group: "reports",
              display: "rows",
              lines: layout.lines,
              total: layout.total,
              hidden: 0,
            }}
            grouped={false}
            time={time}
            timestampFormat={timestampFormat}
            onOpen={openLine}
            onExpand={() => {}}
            footer={null}
          />
        )}
        {loadEarlierControl &&
        !(layout.grouped && layout.sections.some((section) => section.group === "reports")) ? (
          <div className="px-3 py-1.5 text-muted-foreground text-xs">{loadEarlierControl}</div>
        ) : null}
        {unloadedNote ? (
          <div className="px-3 py-1.5 text-muted-foreground text-xs">{unloadedNote}</div>
        ) : null}
      </div>
    </div>
  );
}

function SinceLastVisitSectionRows({
  section,
  grouped,
  time,
  timestampFormat,
  onOpen,
  onExpand,
  footer,
}: {
  section: SinceLastVisitSection<SinceLastVisitLine>;
  grouped: boolean;
  time: (at: number) => string;
  timestampFormat: TimestampFormat;
  onOpen: (event: MouseEvent<HTMLButtonElement>, line: SinceLastVisitLine) => void;
  onExpand: () => void;
  footer: React.ReactNode;
}) {
  const more =
    section.hidden > 0 || footer ? (
      <div className="ps-8 pe-3 pb-1.5 text-muted-foreground text-xs">
        {section.hidden > 0 ? (
          <>
            {section.hidden} more ·{" "}
            <InlineButton tone="muted" onClick={onExpand}>
              Show all
            </InlineButton>
          </>
        ) : null}
        {section.hidden > 0 && footer ? " · " : null}
        {footer}
      </div>
    ) : null;
  return (
    <div className={grouped ? "py-1" : undefined}>
      {grouped ? (
        <div className="px-3 pt-1 text-muted-foreground text-xs">
          {GROUP_LABEL[section.group]} · {section.total}
        </div>
      ) : null}
      {section.display === "names" ? (
        <div className="flex min-w-0 items-start gap-2 px-3 py-1 text-sm">
          <LineIcon line={section.lines[0]!} />
          <span className="min-w-0 flex-1">
            {section.lines.map((line, index) => (
              <span key={line.id}>
                {index > 0 ? ", " : null}
                <button
                  type="button"
                  className="cursor-pointer text-left hover:underline"
                  onClick={(event) => onOpen(event, line)}
                >
                  {lineName(line)}
                </button>
              </span>
            ))}
          </span>
        </div>
      ) : (
        section.lines.map((line) => (
          <button
            key={line.id}
            type="button"
            className="flex w-full min-w-0 cursor-pointer items-start gap-2 px-3 py-1 text-left text-sm hover:bg-accent/40"
            onClick={(event) => onOpen(event, line)}
          >
            <LineIcon line={line} />
            <span className="min-w-0 flex-1">
              {lineText(line, timestampFormat)}
              {line.kind === "report" ? (
                <span className="ms-1.5 inline-flex rounded-sm border border-border/70 px-1 text-muted-foreground text-xs">
                  {line.pullRequests
                    ? line.pullRequests.map((pr) => `#${pr.number} ${pr.state}`).join(", ")
                    : `${line.reportKey} · v${line.version}`}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-muted-foreground text-xs leading-5">
              {time(line.at)}
            </span>
          </button>
        ))
      )}
      {more}
    </div>
  );
}

function LineIcon({ line }: { line: SinceLastVisitLine }) {
  const className = "mt-0.5 size-4 shrink-0";
  switch (line.kind) {
    case "failed":
      return <CircleAlertIcon aria-label="Failed" className={`${className} text-destructive`} />;
    case "limited":
      return <HourglassIcon aria-label="Usage limit" className={`${className} text-warning`} />;
    case "report":
      return <FileTextIcon aria-label="Report" className={`${className} text-primary`} />;
    case "ended":
      return (
        <CircleCheckIcon
          aria-label="Ended a turn"
          className={`${className} text-muted-foreground`}
        />
      );
    case "opened":
      return (
        <PULL_REQUEST_STATE_PRESENTATION.open.Icon
          aria-label="Opened"
          className={`${className} ${PULL_REQUEST_STATE_PRESENTATION.open.toneClassName}`}
        />
      );
    case "merged":
      return (
        <PULL_REQUEST_STATE_PRESENTATION.merged.Icon
          aria-label="Merged"
          className={`${className} ${PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName}`}
        />
      );
  }
}

function lineName(line: SinceLastVisitLine): string {
  return line.kind === "merged" || line.kind === "opened"
    ? `#${line.number} ${line.title}`
    : line.title;
}

function lineText(line: SinceLastVisitLine, timestampFormat: TimestampFormat): string {
  switch (line.kind) {
    case "failed":
      return `${line.title} failed${line.error ? `: ${line.error}` : ""}`;
    case "limited":
      return `${line.title} hit a usage limit${
        line.resetAt ? `, resets ${formatDayAwareTimestamp(line.resetAt, timestampFormat)}` : ""
      }`;
    case "ended":
      return `${line.title} ended a turn`;
    case "opened":
      return `${lineName(line)} opened`;
    case "merged":
      return `${lineName(line)} merged`;
    case "report":
      return line.title;
  }
}
