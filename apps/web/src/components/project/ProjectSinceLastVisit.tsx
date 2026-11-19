import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { coordinatorReports } from "@t3tools/client-runtime/coordinator-reports";
import {
  SINCE_LAST_SEEN_DAYS,
  sinceLastVisitGroups,
  sinceLastVisitHistoryGap,
  sinceLastVisitLayout,
  sinceLastVisitReportLines,
  sinceLastVisitSeenAt,
  sinceLastVisitThreadLines,
  sinceLastVisitUnloadedBefore,
  sinceLastVisitWindow,
  type SinceLastVisitGroup,
  type SinceLastVisitLine,
  type SinceLastVisitSection,
  type SinceLastVisitThreadLine,
} from "@t3tools/client-runtime/project-since-last-visit";
import { projectSeenPatch } from "@t3tools/client-runtime/state/project-coordinators";
import type {
  CoordinatorReport,
  EnvironmentId,
  MessageId,
  ProjectId,
  ScopedThreadRef,
  TimestampFormat,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { CircleAlertIcon, CircleCheckIcon, FileTextIcon, HourglassIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { type MouseEvent, type ReactNode, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import {
  useEnvironmentShellStatuses,
  useQuietThreadShell,
  useThreadHistory,
} from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import {
  environmentThreadDetails,
  environmentThreadShells,
  olderSettledThreads,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp, formatRelativeTimeLabel } from "../../timestampFormat";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { ComposerStackCard } from "../chat/ComposerStackCard";
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
  /** The chat's history has loaded, so an empty list means none rather than not yet. */
  readonly loaded: boolean;
}

const NO_CHAT_REPORTS: ChatReports = {
  key: "",
  messages: [],
  dismissals: [],
  earliestLoadedAt: null,
  loaded: false,
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
    const key = JSON.stringify([
      earliestLoadedAt,
      messages.map((m) => [
        m.id,
        m.report?.version,
        m.reportAnswer?.messageId,
        m.reportAnswer?.version,
      ]),
      dismissals.map((d) => [d.messageId, d.version]),
    ]);
    if (key !== previous.key)
      previous = { key, messages, dismissals, earliestLoadedAt, loaded: true };
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`project-since-last-visit-reports:${threadKey}`));
});

/** What the project page fixes for the card when the chat's snapshot is first live. */
export interface ProjectSinceLastVisitSource {
  /** The chat's project on the chat's machine, whose settings hold the seen mark. */
  readonly projectId: ProjectId;
  /** Every checkout of the project, on any machine. */
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
  /** When the page opened, read once: for the 14-day limit and time labels. */
  readonly openedAt: number;
}

interface ProjectThreadLines {
  readonly key: string;
  readonly lines: ReadonlyArray<SinceLastVisitThreadLine>;
  readonly unloadedBefore: number | null;
}

/**
 * The project's thread lines after `since`, from every machine's shells held through streaming
 * ticks; kept while the same lines result, so a turn streaming anywhere does not re-render the card.
 */
const projectThreadLinesAtom = Atom.family((key: string) => {
  const { chatKey, members, since } = JSON.parse(key) as {
    readonly chatKey: string;
    readonly members: ReadonlyArray<readonly [EnvironmentId, ProjectId]>;
    readonly since: number;
  };
  const chatRef = parseScopedThreadKey(chatKey)!;
  const memberKeys = new Set(members.map(([environmentId, id]) => `${environmentId}:${id}`));
  const machines = [...new Set(members.map(([environmentId]) => environmentId))].map(
    (environmentId) => ({
      environmentId,
      projectIds: new Set(members.filter(([env]) => env === environmentId).map(([, id]) => id)),
    }),
  );
  let previous: ProjectThreadLines = { key: "", lines: [], unloadedBefore: null };
  return Atom.make((get): ProjectThreadLines => {
    const threads = get(environmentThreadShells.quietThreadShellsAtom).filter((thread) =>
      memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
    );
    const lines = sinceLastVisitThreadLines(threads, chatRef, since);
    const unloadedBefore = sinceLastVisitUnloadedBefore(
      machines.map(({ environmentId, projectIds }) => ({
        projectIds,
        olderSettled: get(olderSettledThreads.olderSettledAtom(environmentId)),
      })),
    );
    const next = JSON.stringify([lines, unloadedBefore]);
    if (next !== previous.key) previous = { key: next, lines, unloadedBefore };
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel("project-since-last-visit-threads"));
});

const GROUP_LABEL: Record<SinceLastVisitGroup, string> = {
  failed: "Failed",
  reports: "Reports",
  finished: "Finished",
  merged: "Merged",
};

/**
 * What happened in the project since the user last marked it seen or wrote in its chat, on any
 * device. It shows when the page opens with something to list, stays while the page is open, and
 * goes away when the mark moves, here or elsewhere; it does not appear mid-view. Needs you sits
 * below it, and at most one of the two is open: this one, until Needs you is opened.
 */
export function ProjectSinceLastVisit({
  chatRef,
  source,
  onOpenReport,
  renderNeedsYou,
}: {
  chatRef: ScopedThreadRef;
  source: ProjectSinceLastVisitSource;
  onOpenReport: (messageId: MessageId) => void;
  /** `fold` is set while this card shows. */
  renderNeedsYou: (
    fold: { readonly folded: boolean; readonly onFoldedChange: (folded: boolean) => void } | null,
  ) => ReactNode;
}) {
  const settings = useEnvironmentSettings(chatRef.environmentId);
  const { timestampFormat } = settings;
  const chatShell = useQuietThreadShell(chatRef);
  const window = sinceLastVisitWindow(
    {
      seenAt: settings.projectCoordinators[source.projectId]?.seenAt,
      chat: {
        createdAt: chatShell?.createdAt ?? new Date(source.openedAt).toISOString(),
        latestUserAuthoredMessageAt: chatShell?.latestUserAuthoredMessageAt ?? null,
      },
    },
    source.openedAt,
  );
  const threads = useAtomValue(
    projectThreadLinesAtom(
      JSON.stringify({
        chatKey: scopedThreadKey(chatRef),
        members: source.members.map((member) => [member.environmentId, member.id]),
        since: window.since,
      }),
    ),
  );
  const chat = useAtomValue(chatReportsAtom(scopedThreadKey(chatRef)));
  const history = useThreadHistory(chatRef);
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "mark the project seen",
  });
  const navigate = useNavigate();
  const openPrLink = useOpenPrLink();
  const [expanded, setExpanded] = useState<ReadonlySet<SinceLastVisitGroup>>(new Set());
  const [open, setOpen] = useState<"summary" | "needs" | null>("summary");
  const shellStatuses = useEnvironmentShellStatuses();
  const canMarkSeen = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(chatRef.environmentId),
  );
  const membersKey = source.members
    .map((member) => `${member.environmentId}:${member.id}`)
    .join("|");
  const [phase, setPhase] = useState<
    | { readonly kind: "opening" }
    | { readonly kind: "showing"; readonly since: number }
    /** Nothing to list once ready; decided again if a checkout of the project joins. */
    | { readonly kind: "empty"; readonly membersKey: string }
    | { readonly kind: "seen" }
  >({ kind: "opening" });

  const reportLines = sinceLastVisitReportLines(
    coordinatorReports(chat.messages, chat.dismissals),
    window,
  );
  const gap = sinceLastVisitHistoryGap(
    { hasMoreHistory: history.hasMoreHistory, earliestLoadedAt: chat.earliestLoadedAt },
    window,
  );
  const layout = sinceLastVisitLayout(sinceLastVisitGroups(threads.lines, reportLines), expanded);
  // Decided once the chat's history has loaded and no machine of the project is still syncing.
  const ready =
    chat.loaded &&
    source.members.every((member) => shellStatuses.get(member.environmentId) !== "synchronizing");
  if (phase.kind === "empty" && phase.membersKey !== membersKey) setPhase({ kind: "opening" });
  if (phase.kind === "opening" && ready) {
    setPhase(
      layout.total > 0 ? { kind: "showing", since: window.since } : { kind: "empty", membersKey },
    );
  }
  // Checking on any device ends it here, even if newer changes arrived meanwhile: they wait for
  // the next visit.
  if (phase.kind === "showing" && (window.since > phase.since || layout.total === 0)) {
    setPhase({ kind: "seen" });
  }
  if (phase.kind !== "showing" || window.since > phase.since || layout.total === 0)
    return renderNeedsYou(null);

  const sinceIso = new Date(window.since).toISOString();
  const sinceLabel = window.capped
    ? `the last ${SINCE_LAST_SEEN_DAYS} days`
    : `${formatDayAwareTimestamp(sinceIso, timestampFormat, source.openedAt)}, ${formatRelativeTimeLabel(sinceIso, source.openedAt)}`;
  const time = (at: number) =>
    formatDayAwareTimestamp(new Date(at).toISOString(), timestampFormat, source.openedAt);
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
  const unloadedNote =
    threads.unloadedBefore === null
      ? null
      : `Threads settled before ${time(threads.unloadedBefore)} aren't checked.`;
  const markSeen = () =>
    void saveSettings({
      environmentId: chatRef.environmentId,
      input: {
        patch: projectSeenPatch(
          source.projectId,
          chatRef.threadId,
          sinceLastVisitSeenAt(window, [...threads.lines, ...reportLines]),
        ),
      },
    });

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
    if (line.kind !== "merged") {
      openThread(line);
      return;
    }
    const threadRef = scopeThreadRef(line.environmentId, line.threadId);
    if (openPrLink(event, line.url, threadRef)) openThread(line);
  };
  const expand = (group: SinceLastVisitGroup) => setExpanded(new Set(expanded).add(group));

  return (
    <>
      <ComposerStackCard
        testId="project-since-last-visit"
        label="Since you last checked"
        count={layout.total}
        detail={sinceLabel}
        action={canMarkSeen ? { label: "Mark as seen", onClick: markSeen } : null}
        folded={open !== "summary"}
        onFoldedChange={(folded) => setOpen(folded ? null : "summary")}
      >
        {layout.sections.map((section) => (
          <SinceLastVisitSectionRows
            key={section.group}
            section={section}
            grouped={layout.grouped}
            time={time}
            timestampFormat={timestampFormat}
            onOpen={openLine}
            onExpand={() => expand(section.group)}
            footer={section.group === "reports" ? loadEarlierControl : null}
          />
        ))}
        {loadEarlierControl && !layout.sections.some((section) => section.group === "reports") ? (
          <div className="px-3 py-1.5 text-muted-foreground text-xs">{loadEarlierControl}</div>
        ) : null}
        {unloadedNote ? (
          <div className="px-3 py-1.5 text-muted-foreground text-xs">{unloadedNote}</div>
        ) : null}
      </ComposerStackCard>
      {renderNeedsYou({
        folded: open !== "needs",
        onFoldedChange: (folded) => setOpen(folded ? null : "needs"),
      })}
    </>
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
        <div className="flex min-w-0 items-start gap-2 px-3 py-2 text-sm">
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
            className="flex w-full min-w-0 cursor-pointer items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40"
            onClick={(event) => onOpen(event, line)}
          >
            <LineIcon line={line} />
            <span className="min-w-0 flex-1">
              {lineText(line, timestampFormat)}
              {line.kind === "report" ? (
                <span className="ms-1.5 inline-flex rounded-sm border border-border/70 px-1 text-muted-foreground text-xs">
                  {line.reportKey} · v{line.version}
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
    case "finished":
      return <CircleCheckIcon aria-label="Finished" className={`${className} text-success`} />;
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
  return line.kind === "merged" ? `#${line.number} ${line.title}` : line.title;
}

function lineText(line: SinceLastVisitLine, timestampFormat: TimestampFormat): string {
  switch (line.kind) {
    case "failed":
      return `${line.title} failed${line.error ? `: ${line.error}` : ""}`;
    case "limited":
      return `${line.title} hit a usage limit${
        line.resetAt ? `, resets ${formatDayAwareTimestamp(line.resetAt, timestampFormat)}` : ""
      }`;
    case "finished":
      return `${line.title} finished`;
    case "merged":
      return `${lineName(line)} merged`;
    case "report":
      return line.title;
  }
}
