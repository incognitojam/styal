import { createContext, use, useState } from "react";
import type { CoordinatorReport, MessageId } from "@t3tools/contracts";
import { coordinatorReports } from "@t3tools/client-runtime/coordinator-reports";
import { Button } from "../ui/button";
import { formatRelativeTimeLabel } from "../../timestampFormat";

export type ReportReference = { messageId: MessageId; key: string; version: number };
type Message = {
  id: MessageId;
  role: string;
  text: string;
  report?: CoordinatorReport | undefined;
  reportAnswer?: ReportReference | undefined;
  createdAt: string;
};
export type ReportState = ReturnType<typeof coordinatorReports<Message>>[number];
export const CoordinatorReportsContext = createContext<{
  reports: readonly ReportState[];
  send: (text: string, ref: ReportReference) => Promise<void>;
  reply: (ref: ReportReference) => void;
  dismiss: (ref: ReportReference) => void;
  scroll: (id: MessageId) => void;
  canDismiss: boolean;
  highlighted: MessageId | null;
} | null>(null);
const reportReference = (message: Message): ReportReference => ({
  messageId: message.id,
  key: message.report!.key,
  version: message.report!.version,
});

export function ReportAnswerBar({ report }: { report: ReportState }) {
  const ctx = use(CoordinatorReportsContext);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  if (!ctx) return null;
  if (report.state === "answered")
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        You answered: {report.answer?.text.replace(/^\[[^\n]+\] /, "")}
      </p>
    );
  if (report.state === "dismissed")
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        Dismissed. The agent hears it on its next turn.
      </p>
    );
  if (report.state !== "open") return null;
  const ref = reportReference(report.message);
  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="text-sm font-medium">{report.message.report?.question}</p>
      {sendError ? (
        <p role="alert" className="text-sm text-destructive">
          {sendError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {report.message.report?.answers?.map((answer, index) => (
          <Button
            key={answer}
            size="sm"
            variant={index === 0 ? "default" : "outline"}
            disabled={!ctx.canDismiss || sending}
            onClick={() => {
              setSending(true);
              setSendError(null);
              void ctx
                .send(`[${report.message.report!.title}, version ${ref.version}] ${answer}`, ref)
                .catch(() => setSendError("Could not send your answer. Try again."))
                .finally(() => setSending(false));
            }}
          >
            {answer}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={!ctx.canDismiss || sending}
          onClick={() => ctx.reply(ref)}
        >
          Reply…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!ctx.canDismiss || sending}
          onClick={() => ctx.dismiss(ref)}
        >
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
    <div className="mb-2 rounded-lg border bg-background px-3 py-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        Waiting on you · {open.length}
      </div>
      {open.map(({ message }) => (
        <button
          key={message.id}
          type="button"
          className="flex w-full items-center gap-2 py-1 text-left text-sm"
          onClick={() => scroll(message.id)}
        >
          <span aria-hidden>●</span>
          <span className="font-medium">{message.report!.title}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {message.report!.question}
          </span>
          <span className="text-xs text-muted-foreground">
            v{message.report!.version} · {formatRelativeTimeLabel(message.createdAt)}
          </span>
        </button>
      ))}
    </div>
  );
}
