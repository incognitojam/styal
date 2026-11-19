import { WorkflowRunReviewRow } from "./WorkflowRunReviewPanel";
import type { ChatMessage } from "../../types";
import { FileTextIcon, MessageSquareIcon, ReplyIcon, XIcon } from "lucide-react";
import { createContext, use, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { MessageId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import {
  coordinatorReports,
  formatReportAnswer,
  reportAnswerDisplay,
  waitingCoordinatorReports,
} from "@t3tools/client-runtime/coordinator-reports";
import { Button } from "../ui/button";
import { ComposerStackCard, type ComposerStackFold } from "./ComposerStackCard";
import { NextUnreadChip } from "./NextUnreadChip";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type AnsweredNeed,
  AnsweredNeedRow,
  ProjectNeedRow,
  useProjectNeeds,
} from "../project/ProjectNeedsYou";

const NO_PROJECT_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];

export type ReportReference = { messageId: MessageId; key: string; version: number };
export type ReportState = ReturnType<
  typeof coordinatorReports<
    Pick<
      ChatMessage,
      "id" | "role" | "text" | "report" | "reportAnswer" | "context" | "attachments" | "createdAt"
    >
  >
>[number];
/** The report a user message answers, and the text typed after the report's prefix. */
export type ReportAnswer = { messageId: MessageId; title: string; version: number; text: string };
export const CoordinatorReportsContext = createContext<{
  reports: readonly ReportState[];
  answers: ReadonlyMap<MessageId, ReportAnswer>;
  send: (text: string, ref: ReportReference) => Promise<void>;
  reply: (ref: ReportReference, title: string) => void;
  dismiss: (ref: ReportReference) => void;
  scroll: (id: MessageId) => void;
  canOperate: boolean;
  target: { messageId: MessageId } | null;
  clear: () => void;
} | null>(null);
export function ReportAnswerBar({
  report,
  renderAnswer,
}: {
  report: ReportState;
  /** Renders a typed reply the way its user bubble does, with context chips and line breaks. */
  renderAnswer: (answer: NonNullable<ReportState["answer"]>, text: string) => ReactNode;
}) {
  const ctx = use(CoordinatorReportsContext);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  if (!ctx) return null;
  const panelClassName = "flex flex-col gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-sm";
  if (report.state === "dismissed") {
    return (
      <div className={panelClassName}>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
          <XIcon />
          Dismissed. The agent hears it on its next turn.
        </span>
      </div>
    );
  }
  if (report.state === "answered" && report.answer) {
    const { text, compact } = reportAnswerDisplay(report.answer, report.message.report!);
    if (compact) {
      return (
        <div className={panelClassName}>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
            <MessageSquareIcon />
            You answered: <span className="text-foreground">{text}</span>
          </span>
        </div>
      );
    }
    return (
      <div className={panelClassName}>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
          <MessageSquareIcon />
          You answered
        </span>
        {renderAnswer(report.answer, text)}
      </div>
    );
  }
  if (report.state !== "open") return null;
  const tag = report.message.report!;
  const ref = { messageId: report.message.id, key: tag.key, version: tag.version };
  const disabled = !ctx.canOperate || sending;
  return (
    <div className={panelClassName}>
      <span className="font-medium">{tag.question}</span>
      {sendError ? (
        <p role="alert" className="text-sm text-destructive">
          {sendError}
        </p>
      ) : null}
      <ReportAnswerOptions
        answers={tag.answers ?? []}
        disabled={disabled}
        onPick={(answer) => {
          setSending(true);
          setSendError(null);
          void ctx
            .send(formatReportAnswer(tag, answer), ref)
            .catch(() => setSendError("Could not send your answer. Try again."))
            .finally(() => setSending(false));
        }}
      />
      <div className="flex items-center justify-between">
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => ctx.reply(ref, tag.title)}
        >
          <ReplyIcon />
          Reply…
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => ctx.dismiss(ref)}
        >
          <XIcon />
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** A report's offered answers, recommended first. */
export function ReportAnswerOptions({
  answers,
  disabled,
  onPick,
}: {
  answers: readonly string[];
  disabled: boolean;
  onPick: (answer: string) => void;
}) {
  return answers.map((answer, index) => (
    <button
      key={answer}
      type="button"
      disabled={disabled}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-md border px-3 py-1.5 text-left hover:bg-accent/60 disabled:cursor-default disabled:opacity-64",
        index === 0 ? "border-primary/50 bg-primary/8" : "border-input bg-background/40",
      )}
      onClick={() => onPick(answer)}
    >
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{answer}</span>
      {index === 0 ? (
        <span className="shrink-0 rounded-full bg-primary/12 px-1.5 text-xs leading-5 text-primary">
          Recommended
        </span>
      ) : null}
    </button>
  ));
}

/** Names the report a user message answers and opens that report version. */
export function ReportAnswerChip({
  title,
  version,
  messageId,
}: {
  title: string;
  version: number;
  messageId: MessageId;
}) {
  const ctx = use(CoordinatorReportsContext);
  return (
    <ContextChip
      render={<button type="button" />}
      aria-label={`Open report ${title}, version ${version}`}
      onClick={() => ctx?.scroll(messageId)}
    >
      <FileTextIcon />
      <ContextChipLabel>{title}</ContextChipLabel>
      <span className="shrink-0">· v{version}</span>
    </ContextChip>
  );
}

/** Sits at the top of the composer while the next message replies to a report. */
export function ReportReplyStrip({
  title,
  version,
  question,
  onCancel,
}: {
  title: string;
  version: number;
  question: string | undefined;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-start gap-2 border-b border-border/60 py-2 ps-4 pe-2 text-sm">
      <span className="w-0.5 self-stretch rounded-full bg-primary/60" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
          <ReplyIcon />
          <span className="shrink-0">Replying to</span>
          <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
          <span className="shrink-0">· version {version}</span>
        </div>
        {question ? <div className="truncate">{question}</div> : null}
      </div>
      <Button size="icon-xs" variant="ghost-muted" aria-label="Stop replying" onClick={onCancel}>
        <XIcon />
      </Button>
    </div>
  );
}

/**
 * Opening a report folds the card, since the report is answered in the timeline. Opening a thread's
 * question narrows the card to it until it is answered or closed.
 */
export function NeedsYou({
  reports,
  scroll,
  runs,
  project = NO_PROJECT_THREADS,
  fold,
  unreadChip = true,
  ...reviewProps
}: {
  reports: readonly ReportState[];
  scroll: (id: MessageId) => void;
  runs: ReadonlyArray<ThreadWorkflowRunWatch>;
  /** On a project page: the project's threads that need you, answered here. */
  project?: ReadonlyArray<EnvironmentThreadShell>;
  /** Set when the stack decides it: otherwise the card keeps its own. */
  fold?: ComposerStackFold;
  /** False while thread find is open. */
  unreadChip?: boolean;
} & Omit<ComponentProps<typeof WorkflowRunReviewRow>, "run">) {
  const [expanded, setExpanded] = useState(false);
  const [ownFolded, setOwnFolded] = useState(false);
  const headerRef = useRef<HTMLButtonElement>(null);
  const [openNeed, setOpenNeed] = useState<string | null>(null);
  // The latest answer only; the rows follow each thread's own pending state.
  const [answered, setAnswered] = useState<AnsweredNeed | null>(null);
  const needs = useProjectNeeds(project);
  const rows = [
    ...runs.filter((run) => run.review !== undefined).map((run) => ({ kind: "run" as const, run })),
    ...waitingCoordinatorReports(reports).map((report) => ({ kind: "report" as const, report })),
    ...needs.map((need) => ({ kind: "need" as const, need })),
  ];
  // A single item costs less room than the click it would take to unfold it, until the
  // stack is folded or unfolded by hand.
  const folded = fold ? fold.folded && !(fold.initial && rows.length === 1) : ownFolded;
  const setFolded = fold?.onFoldedChange ?? setOwnFolded;
  if (!rows.length && !answered) return null;
  const opened = rows.filter((row) => row.kind === "need" && row.need.key === openNeed);
  const visible = opened.length ? opened : expanded ? rows : rows.slice(0, 3);
  const collapse = () => {
    setOpenNeed(null);
    setExpanded(false);
  };
  return (
    <ComposerStackCard
      label={rows.length ? "Needs you" : "Answered"}
      count={rows.length || undefined}
      aside={unreadChip ? <NextUnreadChip inline /> : null}
      folded={folded}
      onFoldedChange={(next) => {
        collapse();
        setFolded(next);
      }}
      headerRef={headerRef}
      action={
        folded || rows.length <= (opened.length ? 1 : 3)
          ? null
          : expanded
            ? { label: "Show less", onClick: collapse }
            : {
                label: `Show all ${rows.length}`,
                onClick: () => {
                  setOpenNeed(null);
                  setExpanded(true);
                },
              }
      }
      footer={
        answered ? (
          <div className="border-t border-border/60">
            <AnsweredNeedRow answered={answered} />
          </div>
        ) : null
      }
    >
      {visible.map((row, index) =>
        row.kind === "run" ? (
          <WorkflowRunReviewRow
            key={`${row.run.host}/${row.run.repository}/${row.run.runId}`}
            {...reviewProps}
            run={row.run}
            // The thread's background-work actions belong to the first run only.
            {...(index === 0 ? {} : { watchActions: undefined })}
          />
        ) : row.kind === "need" ? (
          <ProjectNeedRow
            key={row.need.key}
            need={row.need}
            open={openNeed === row.need.key}
            onToggle={() => {
              setExpanded(false);
              setOpenNeed(openNeed === row.need.key ? null : row.need.key);
            }}
            onAnswered={(answer) => {
              collapse();
              setAnswered({ threadTitle: row.need.thread.title, answer });
            }}
          />
        ) : (
          <button
            key={row.report.message.id}
            type="button"
            className="flex min-w-0 cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-accent/40"
            onClick={() => {
              collapse();
              setFolded(true);
              // The row goes with the body; keep keyboard focus in the card.
              headerRef.current?.focus({ preventScroll: true });
              scroll(row.report.message.id);
            }}
          >
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-sm text-foreground">
                {row.report.message.report!.question}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {row.report.message.report!.title} · v{row.report.message.report!.version} ·{" "}
                {formatRelativeTimeLabel(row.report.message.createdAt)}
              </span>
            </span>
          </button>
        ),
      )}
    </ComposerStackCard>
  );
}
