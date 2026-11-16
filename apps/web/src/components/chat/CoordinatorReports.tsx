import type { ChatMessage } from "../../types";
import { ClockIcon, MessageSquareIcon, ReplyIcon, XIcon } from "lucide-react";
import { createContext, use, useState } from "react";
import type { MessageId } from "@t3tools/contracts";
import {
  coordinatorReports,
  formatReportAnswer,
} from "@t3tools/client-runtime/coordinator-reports";
import { Button } from "../ui/button";
import { formatRelativeTimeLabel } from "../../timestampFormat";

export type ReportReference = { messageId: MessageId; key: string; version: number };
export type ReportState = ReturnType<
  typeof coordinatorReports<Pick<ChatMessage, "id" | "role" | "text" | "report" | "createdAt">>
>[number];
export const CoordinatorReportsContext = createContext<{
  reports: readonly ReportState[];
  send: (text: string, ref: ReportReference) => Promise<void>;
  reply: (ref: ReportReference, title: string) => void;
  dismiss: (ref: ReportReference) => void;
  scroll: (id: MessageId) => void;
  canOperate: boolean;
  target: { messageId: MessageId } | null;
  clear: () => void;
} | null>(null);
export function ReportAnswerBar({ report }: { report: ReportState }) {
  const ctx = use(CoordinatorReportsContext);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  if (!ctx) return null;
  const panelClassName =
    "flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm";
  if (report.state === "answered" || report.state === "dismissed") {
    const answered = report.state === "answered";
    return (
      <div className={panelClassName}>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
          {answered ? <MessageSquareIcon /> : <XIcon />}
          {answered ? "You answered: " : "Dismissed. The agent hears it on its next turn."}
          {answered ? (
            <span className="text-foreground">
              {report.answer?.text.replace(/^\[[^\n]+\] /, "")}
            </span>
          ) : null}
        </span>
      </div>
    );
  }
  if (report.state !== "open") return null;
  const tag = report.message.report!;
  const ref = { messageId: report.message.id, key: tag.key, version: tag.version };
  return (
    <div className={panelClassName}>
      <span className="font-medium">{tag.question}</span>
      {sendError ? (
        <p role="alert" className="text-sm text-destructive">
          {sendError}
        </p>
      ) : null}
      {tag.answers?.map((answer, index) => (
        <Button
          key={answer}
          size="xs"
          variant={index === 0 ? "default" : "outline"}
          disabled={!ctx.canOperate || sending}
          onClick={() => {
            setSending(true);
            setSendError(null);
            void ctx
              .send(formatReportAnswer(tag, answer), ref)
              .catch(() => setSendError("Could not send your answer. Try again."))
              .finally(() => setSending(false));
          }}
        >
          {answer}
        </Button>
      ))}
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={!ctx.canOperate || sending}
        onClick={() => ctx.reply(ref, tag.title)}
      >
        <ReplyIcon />
        Reply…
      </Button>
      <div className="ms-auto">
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!ctx.canOperate || sending}
          onClick={() => ctx.dismiss(ref)}
        >
          <XIcon />
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function WaitingReports({
  reports,
  scroll,
}: {
  reports: readonly ReportState[];
  scroll: (id: MessageId) => void;
}) {
  const open = reports
    .filter((report) => report.state === "open")
    .toSorted((a, b) => a.message.createdAt.localeCompare(b.message.createdAt));
  if (!open.length) return null;
  return (
    <div className="mx-auto mb-2 w-full max-w-(--chat-content-max-width)">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
        <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
          <ClockIcon />
          Waiting on you · {open.length}
        </div>
        <div className="flex flex-col divide-y divide-border/60">
          {open.map(({ message }) => (
            <button
              key={message.id}
              type="button"
              className="group/row flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/40"
              onClick={() => scroll(message.id)}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
              <span className="min-w-0 truncate font-medium">{message.report!.title}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {message.report!.question}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground/80">
                v{message.report!.version} · {formatRelativeTimeLabel(message.createdAt)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
