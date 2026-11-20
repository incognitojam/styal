import { WorkflowRunReviewRow } from "./WorkflowRunReviewPanel";
import type { ChatMessage } from "../../types";
import {
  CheckIcon,
  FileTextIcon,
  MessageSquareIcon,
  ReplyIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { createContext, use, useState, type ComponentProps, type ReactNode } from "react";
import type { MessageId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import {
  coordinatorReports,
  formatReportAnswer,
  answeredReportResult,
  reportAnswerDisplay,
  reportResponseDelivered,
  reportResponsePending,
  waitingCoordinatorReports,
} from "@t3tools/client-runtime/coordinator-reports";
import { threadReportResponsesAtom } from "../../state/coordinatorReports";
import { Button } from "../ui/button";
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
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { environmentThreadDetails } from "../../state/threads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";

const NO_PROJECT_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];
const NO_THREAD_STATE = Atom.make(null);

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
  answer: (text: string, ref: ReportReference) => void;
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
  // A resolved question asks again here until the person answers or cancels.
  const [reopened, setReopened] = useState(false);
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
  if (report.state === "resolved" && !reopened) {
    const { question, resolved } = report.message.report!;
    return (
      <div className={panelClassName}>
        <span className="text-muted-foreground">{question}</span>
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-start gap-1.5 text-muted-foreground [&_svg]:mt-0.75 [&_svg]:size-3.5 [&_svg]:shrink-0">
            <CheckIcon />
            <span className="min-w-0 break-words">
              Resolved by the agent
              {resolved?.outcome ? (
                <>
                  : <span className="text-foreground">{resolved.outcome}</span>
                </>
              ) : null}
            </span>
          </span>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!ctx.canOperate}
            onClick={() => setReopened(true)}
          >
            <RotateCcwIcon />
            Reopen
          </Button>
        </div>
      </div>
    );
  }
  if (report.state === "answered" && report.answer) {
    const { text, compact } = reportAnswerDisplay(report.answer, report.message.report!);
    const outcome = answeredReportResult(report.message.report!, report.answer);
    return (
      <div className={panelClassName}>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
          <MessageSquareIcon />
          {compact ? (
            <>
              You answered: <span className="text-foreground">{text}</span>
            </>
          ) : (
            "You answered"
          )}
        </span>
        {compact ? null : renderAnswer(report.answer, text)}
        {outcome ? (
          <span className="flex min-w-0 items-start gap-1.5 text-muted-foreground [&_svg]:mt-0.75 [&_svg]:size-3.5 [&_svg]:shrink-0">
            <CheckIcon />
            <span className="min-w-0 break-words">Result: {outcome}</span>
          </span>
        ) : null}
      </div>
    );
  }
  if (report.state !== "open" && report.state !== "resolved") return null;
  const tag = report.message.report!;
  const ref = { messageId: report.message.id, key: tag.key, version: tag.version };
  const disabled = !ctx.canOperate;
  return (
    <div className={panelClassName}>
      <span className="font-medium">{tag.question}</span>
      <ReportAnswerOptions
        answers={tag.answers ?? []}
        disabled={disabled}
        onPick={(answer) => ctx.answer(formatReportAnswer(tag, answer), ref)}
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
        {report.state === "resolved" ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setReopened(false)}>
            Cancel
          </Button>
        ) : (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled}
            onClick={() => ctx.dismiss(ref)}
          >
            <XIcon />
            Dismiss
          </Button>
        )}
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
  // The latest answer only; the rows follow each thread's own pending state.
  const [answered, setAnswered] = useState<AnsweredNeed | null>(null);
  // Shown while its response is on its way and once the thread shows it, never after it fails.
  const summaryRef = answered?.report?.need.thread;
  const summaryThread = summaryRef ? scopeThreadRef(summaryRef.environmentId, summaryRef.id) : null;
  const summaryResponses = useAtomValue(
    threadReportResponsesAtom(summaryThread ? threadKey(summaryThread) : ""),
  );
  const summaryState = useAtomValue(
    summaryThread ? environmentThreadDetails.stateAtom(summaryThread) : NO_THREAD_STATE,
  );
  const summaryProjection = summaryState === null ? null : Option.getOrNull(summaryState.data);
  const summaryResponse = answered?.report?.response;
  const shownAnswered =
    !summaryResponse ||
    reportResponsePending(summaryResponses, summaryResponse) ||
    (summaryProjection !== null &&
      reportResponseDelivered(
        {
          messages: summaryProjection.messages,
          dismissals: summaryProjection.thread.reportDismissals ?? [],
        },
        summaryResponse,
      ))
      ? answered
      : null;
  const needs = useProjectNeeds(project);
  const rows = [
    ...runs.filter((run) => run.review !== undefined).map((run) => ({ kind: "run" as const, run })),
    ...waitingCoordinatorReports(reports).map((report) => ({ kind: "report" as const, report })),
    ...needs.map((need) => ({ kind: "need" as const, need })),
  ];
  if (!rows.length && !shownAnswered) return null;
  const visible = expanded ? rows : rows.slice(0, 3);
  return (
    <div className="mx-auto mb-2 w-full max-w-(--chat-content-max-width)">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          <span>{rows.length ? `Needs you · ${rows.length}` : "Answered"}</span>
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
                onAnswered={(answer, report) =>
                  setAnswered({
                    threadTitle: row.need.thread.title,
                    answer,
                    ...(report ? { report } : {}),
                  })
                }
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
