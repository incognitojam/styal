import { WorkflowRunReviewRow } from "./WorkflowRunReviewPanel";
import type { ChatMessage } from "../../types";
import { CheckIcon, FileTextIcon, MessageSquareIcon, ReplyIcon, XIcon } from "lucide-react";
import { createContext, use, useState, type ComponentProps, type ReactNode } from "react";
import type { MessageId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import {
  coordinatorReports,
  formatReportAnswer,
  pendingReportDismissals,
  reportAnswerDelivery,
  reportAnswerDisplay,
  reportResponseFailure,
  waitingCoordinatorReports,
} from "@t3tools/client-runtime/coordinator-reports";
import type { ReportResponse } from "../../state/coordinatorReports";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type AnsweredNeed,
  AnsweredNeedRow,
  type AnsweredReport,
  ProjectNeedRow,
  useAnsweredReportStatuses,
  useProjectNeeds,
} from "../project/ProjectNeedsYou";
import { needRowsWithResponses } from "../project/projectNeedsYou.logic";

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
  /** Responses this client sent that the server does not show yet, and ones that failed. */
  responses: readonly ReportResponse[];
  /** Message ids still sending, and ids of answers waiting in the queue behind a running turn. */
  delivery: { sending: readonly string[]; queued: readonly string[] };
  answer: (text: string, ref: ReportReference) => void;
  reply: (ref: ReportReference, title: string) => void;
  dismiss: (ref: ReportReference) => void;
  scroll: (id: MessageId) => void;
  canOperate: boolean;
  target: { messageId: MessageId } | null;
  clear: () => void;
} | null>(null);
/** Why a response failed, with the server's reason, when it gave one, on hover. */
export function ReportFailure({
  failure,
  className,
}: {
  failure: { readonly message: string; readonly detail?: string };
  className?: string;
}) {
  const text = (
    <span role="alert" className={cn("min-w-0 truncate text-xs text-destructive", className)}>
      {failure.message}
    </span>
  );
  if (failure.detail === undefined) return text;
  return (
    <Tooltip>
      <TooltipTrigger render={text} />
      <TooltipPopup side="top">{failure.detail}</TooltipPopup>
    </Tooltip>
  );
}

export function ReportAnswerBar({
  report,
  renderAnswer,
}: {
  report: ReportState;
  /** Renders a typed reply the way its user bubble does, with context chips and line breaks. */
  renderAnswer: (answer: NonNullable<ReportState["answer"]>, text: string) => ReactNode;
}) {
  const ctx = use(CoordinatorReportsContext);
  if (!ctx) return null;
  const panelClassName = "flex flex-col gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-sm";
  const tag = report.message.report!;
  const ref = { messageId: report.message.id, key: tag.key, version: tag.version };
  const dismissing = pendingReportDismissals(ctx.responses).some(
    (pending) =>
      pending.messageId === ref.messageId &&
      pending.key === ref.key &&
      pending.version === ref.version,
  );
  const delivery =
    report.state === "answered" && report.answer
      ? reportAnswerDelivery(report.answer.id, ctx.delivery)
      : "delivered";
  // Until the agent has the response the card keeps its open shape, so it does not jump.
  const responding = dismissing ? "dismissing" : delivery === "delivered" ? null : delivery;
  if (responding === null && report.state === "dismissed") {
    return (
      <div className={panelClassName}>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
          <XIcon />
          Dismissed. The agent hears it on its next turn.
        </span>
      </div>
    );
  }
  if (responding === null && report.state === "answered" && report.answer) {
    const { text, compact } = reportAnswerDisplay(report.answer, tag);
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
  if (responding === null && report.state !== "open") return null;
  const answers = tag.answers ?? [];
  const chosen =
    responding !== null && report.answer ? reportAnswerDisplay(report.answer, tag).text : null;
  const failure = responding === null ? reportResponseFailure(ctx.responses, ref) : undefined;
  const disabled = !ctx.canOperate || responding !== null;
  return (
    <div className={panelClassName}>
      <span className="font-medium">{tag.question}</span>
      <ReportAnswerOptions
        answers={answers}
        disabled={disabled}
        chosen={chosen}
        onPick={(answer) => ctx.answer(formatReportAnswer(tag, answer), ref)}
      />
      <div className="flex h-7 items-center justify-between gap-2 sm:h-6">
        {responding !== null ? (
          <span
            role="status"
            className="inline-flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground [&_svg]:size-3.5"
          >
            <MessageSquareIcon className="shrink-0" />
            <span className="truncate">
              {responding === "dismissing"
                ? "Dismissing"
                : responding === "queued"
                  ? "Queued until the current turn ends"
                  : chosen !== null && answers.includes(chosen)
                    ? "Sending your answer"
                    : "Sending your reply"}
            </span>
          </span>
        ) : (
          <>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => ctx.reply(ref, tag.title)}
            >
              <ReplyIcon />
              Reply…
            </Button>
            {failure ? <ReportFailure failure={failure} /> : null}
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => ctx.dismiss(ref)}
            >
              <XIcon />
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** A report's offered answers, recommended first. */
export function ReportAnswerOptions({
  answers,
  disabled,
  chosen = null,
  onPick,
}: {
  answers: readonly string[];
  disabled: boolean;
  /** The answer already sent, marked while it is on its way. */
  chosen?: string | null;
  onPick: (answer: string) => void;
}) {
  return answers.map((answer, index) => (
    <button
      key={answer}
      type="button"
      disabled={disabled}
      aria-pressed={chosen === null ? undefined : answer === chosen}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-md border px-3 py-1.5 text-left hover:bg-accent/60 disabled:cursor-default disabled:opacity-64",
        index === 0 ? "border-primary/50 bg-primary/8" : "border-input bg-background/40",
        answer === chosen && "border-primary bg-primary/12 disabled:opacity-100",
      )}
      onClick={() => onPick(answer)}
    >
      {answer === chosen ? <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
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

export function NeedsYou({
  reports,
  scroll,
  runs,
  project = NO_PROJECT_THREADS,
  ...reviewProps
}: {
  reports: readonly ReportState[];
  scroll: (id: MessageId) => void;
  runs: ReadonlyArray<ThreadWorkflowRunWatch>;
  /** On a project page: the project's threads that need you, answered here. */
  project?: ReadonlyArray<EnvironmentThreadShell>;
} & Omit<ComponentProps<typeof WorkflowRunReviewRow>, "run">) {
  const [expanded, setExpanded] = useState(false);
  const [openNeed, setOpenNeed] = useState<string | null>(null);
  // The latest answer, shown once the agent has it.
  const [answered, setAnswered] = useState<AnsweredNeed | null>(null);
  // Every response sent from here, so each keeps its row until the agent has it.
  const [sent, setSent] = useState<ReadonlyArray<AnsweredReport>>([]);
  const needs = useProjectNeeds(project);
  const statuses = useAnsweredReportStatuses(sent);
  const needRows = needRowsWithResponses(
    needs,
    sent.flatMap((entry, index) => {
      const status = statuses[index];
      return typeof status === "object" ? [{ need: entry.need, responding: status }] : [];
    }),
  );
  const answeredStatus = answered?.report
    ? (statuses[sent.indexOf(answered.report)] ?? null)
    : null;
  const rows = [
    ...runs.filter((run) => run.review !== undefined).map((run) => ({ kind: "run" as const, run })),
    ...waitingCoordinatorReports(reports).map((report) => ({ kind: "report" as const, report })),
    ...needRows.map((row) => ({ kind: "need" as const, ...row })),
  ];
  const waiting = rows.filter((row) => row.kind !== "need" || !row.responding).length;
  const shownAnswered = answeredStatus === null || answeredStatus === "delivered" ? answered : null;
  if (!rows.length && !shownAnswered) return null;
  const visible = expanded ? rows : rows.slice(0, 3);
  return (
    <div className="mx-auto mb-2 w-full max-w-(--chat-content-max-width)">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          <span>{waiting ? `Needs you · ${waiting}` : "Answered"}</span>
          {rows.length > 3 ? (
            <Button size="xs" variant="ghost" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : `Show all ${rows.length}`}
            </Button>
          ) : null}
        </div>
        <div className="flex max-h-[min(24rem,45dvh)] flex-col divide-y divide-border/60 overflow-y-auto">
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
                onToggle={() => setOpenNeed(openNeed === row.need.key ? null : row.need.key)}
                onAnswered={(answer, report) => {
                  setAnswered({
                    threadTitle: row.need.thread.title,
                    answer,
                    ...(report ? { report } : {}),
                  });
                  if (report)
                    setSent((current) => [
                      ...current.filter((entry) => entry.need.key !== report.need.key),
                      report,
                    ]);
                }}
                {...(row.responding ? { responding: row.responding } : {})}
              />
            ) : (
              <button
                key={row.report.message.id}
                type="button"
                className="flex min-w-0 cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-accent/40"
                onClick={() => scroll(row.report.message.id)}
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
        </div>
        {shownAnswered ? (
          <div className="border-t border-border/60">
            <AnsweredNeedRow answered={shownAnswered} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
