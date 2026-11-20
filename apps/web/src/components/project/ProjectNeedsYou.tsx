import { useAtomValue } from "@effect/atom-react";
import { formatReportAnswer } from "@t3tools/client-runtime/coordinator-reports";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  seedUserInputDraftAnswers,
  type ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  type PendingUserInputDraftAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type MessageId,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { deriveToolRowPresentation } from "@t3tools/shared/toolRowPresentation";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { ChevronRightIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { cn, newMessageId, randomUUID } from "~/lib/utils";
import {
  dismissCoordinatorReport,
  respondToReport,
  threadReportResponsesAtom,
  type ReportResponse,
} from "../../state/coordinatorReports";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ChildApproval } from "../chat/ChildThreadApprovals";
import { ReportAnswerOptions } from "../chat/CoordinatorReports";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  listProjectNeeds,
  openReports,
  type ProjectNeed,
  type ThreadNeeds,
} from "./projectNeedsYou.logic";

// Only threads that need you are subscribed; each one streams its thread detail.
const threadNeedsAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous: readonly unknown[] = [];
  let value: ThreadNeeds | null = null;
  return Atom.make((get) => {
    const requests = get(environmentThreadDetails.pendingRequestsAtom(ref));
    const projection = Option.getOrNull(get(environmentThreadDetails.stateAtom(ref)).data);
    const responses = get(threadReportResponsesAtom(key));
    if (requests === null || projection === null) return null;
    const inputs = [requests, projection.messages, projection.thread.reportDismissals, responses];
    if (inputs.some((input, index) => input !== previous[index])) {
      previous = inputs;
      value = {
        requests,
        reports: openReports(projection, responses),
        responding: responses.length > 0,
      };
    }
    return value;
  });
});
const projectNeedsAtom = Atom.family((keys: string) =>
  Atom.make((get) => {
    const needs = new Map<string, ThreadNeeds | null>();
    for (const key of keys.split("\n")) if (key) needs.set(key, get(threadNeedsAtom(key)));
    return needs;
  }),
);

/** What the threads in `threads` wait on, oldest first. */
export function useProjectNeeds(threads: ReadonlyArray<EnvironmentThreadShell>) {
  const keyOf = (thread: EnvironmentThreadShell) =>
    threadKey(scopeThreadRef(thread.environmentId, thread.id));
  const needs = useAtomValue(projectNeedsAtom(threads.map(keyOf).toSorted().join("\n")));
  return listProjectNeeds(threads, (thread) => needs.get(keyOf(thread)) ?? null);
}

const APPROVAL_HEADINGS = {
  command: "Run command",
  "file-change": "Change files",
  "file-read": "Read file",
  permission: "Permission",
  "mcp-elicitation": "App access",
} satisfies Record<ThreadPendingApproval["requestKind"], string>;

const DECISION_LABELS = {
  accept: "Approved",
  acceptForSession: "Approved for this session",
  acceptAlways: "Always approved",
  decline: "Declined",
  cancel: "Cancelled",
} satisfies Record<ProviderApprovalDecision, string>;

function summary(need: ProjectNeed): string {
  switch (need.kind) {
    case "approval": {
      const { approval } = need;
      const heading =
        (approval.toolName
          ? deriveToolRowPresentation({ toolName: approval.toolName, input: approval.toolInput })
              ?.heading
          : undefined) ?? APPROVAL_HEADINGS[approval.requestKind];
      return approval.detail ? `${heading}: ${approval.detail}` : heading;
    }
    case "question":
      return need.userInput.questions[0]?.question ?? "A question";
    case "report":
      return need.report.report.question ?? need.report.report.title;
    case "thread":
      return need.thread.pendingSubagentRequest
        ? "A subagent is waiting for you"
        : "Waiting for you in its thread";
  }
}

/**
 * A report response sent from the card, so its summary can step back if the send fails. Without
 * one it was a typed reply, which leaves the question open.
 */
export interface AnsweredReport {
  readonly need: Extract<ProjectNeed, { kind: "report" }>;
  readonly response?: ReportResponse;
}

export interface AnsweredNeed {
  readonly threadTitle: string;
  readonly answer: string;
  readonly report?: AnsweredReport;
}

// The card scrolls; an opened row near its bottom brings its answers into view. Stable, so
// React calls it once when the body mounts, not on every render.
const scrollIntoViewOnMount = (body: HTMLElement | null) =>
  body?.scrollIntoView({ block: "nearest" });

export function ProjectNeedRow({
  need,
  open,
  onToggle,
  onAnswered,
}: {
  need: ProjectNeed;
  open: boolean;
  onToggle: () => void;
  onAnswered: (answer: string, report?: AnsweredReport) => void;
}) {
  const navigate = useNavigate();
  const ref = scopeThreadRef(need.thread.environmentId, need.thread.id);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full min-w-0 cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-accent/40"
        onClick={onToggle}
      >
        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-sm text-foreground",
              open ? "whitespace-pre-wrap break-words" : "truncate",
            )}
          >
            {summary(need)}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {need.thread.title} · {formatRelativeTimeLabel(need.createdAt)}
          </span>
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn("mt-2.5 size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div ref={scrollIntoViewOnMount} className="flex flex-col gap-2 px-3 pb-3 ps-6.5">
          <NeedAnswer need={need} onAnswered={onAnswered} />
          <Button
            size="xs"
            variant="ghost-muted"
            className="-ms-2 self-start"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(ref),
              })
            }
          >
            Open thread
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function AnsweredNeedRow({ answered }: { answered: AnsweredNeed }) {
  const dismissed = answered.report?.response?.kind === "dismiss";
  const replied = answered.report !== undefined && answered.report.response === undefined;
  return (
    <div className="flex min-w-0 items-start gap-2 px-3 py-2 text-sm [&_svg]:size-3.5">
      <MessageSquareIcon className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-muted-foreground">
          {dismissed ? "Dismissed · " : replied ? "Replied · sent to " : "Answered · sent to "}
          <span className="text-foreground">{answered.threadTitle}</span>
        </span>
        {dismissed ? null : (
          <span className="line-clamp-2 whitespace-pre-wrap">{answered.answer}</span>
        )}
      </span>
    </div>
  );
}

function NeedAnswer({
  need,
  onAnswered,
}: {
  need: ProjectNeed;
  onAnswered: (answer: string, report?: AnsweredReport) => void;
}) {
  switch (need.kind) {
    case "approval":
      return (
        <ChildApproval
          bare
          entry={{
            thread: scopeThreadRef(need.thread.environmentId, need.thread.id),
            title: need.thread.title,
            approval: need.approval,
          }}
          onResponded={(decision) => onAnswered(DECISION_LABELS[decision])}
        />
      );
    case "question":
      return <QuestionAnswer need={need} onAnswered={onAnswered} />;
    case "report":
      return <ReportAnswer need={need} onAnswered={onAnswered} />;
    case "thread":
      return null;
  }
}

function useAnswerCommand() {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    send: () => Promise<AtomCommandResult<unknown, unknown>>,
    failure: string,
    onSuccess: () => void,
  ) => {
    setSending(true);
    setError(null);
    const result = await send();
    setSending(false);
    if (result._tag === "Success") onSuccess();
    else if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : failure);
    }
  };
  const alert = error ? (
    <p role="alert" className="text-xs text-destructive">
      {error}
    </p>
  ) : null;
  return { sending, run, alert };
}

function QuestionAnswer({
  need,
  onAnswered,
}: {
  need: Extract<ProjectNeed, { kind: "question" }>;
  onAnswered: (answer: string) => void;
}) {
  const { environmentId, id: threadId } = need.thread;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const { sending, run, alert } = useAnswerCommand();
  const { requestId, questions } = need.userInput;
  // Shown and sent alike, so a prefilled answer can be sent unchanged.
  const seeded = seedUserInputDraftAnswers(questions, drafts);
  const answers = buildPendingUserInputAnswers(questions, seeded);
  const disabled = !canOperate || sending || need.userInput.responseCapability === "not_resumable";
  const update = (id: string, draft: PendingUserInputDraftAnswer) =>
    setDrafts({ ...seeded, [id]: draft });
  return (
    <div className="flex flex-col gap-2 text-sm">
      {questions.map((question) => (
        <fieldset key={question.id} className="flex min-w-0 flex-col gap-1.5" disabled={disabled}>
          {/* The opened row shows the first question in full. */}
          <legend className={questions.length === 1 ? "sr-only" : "mb-1 font-medium"}>
            {question.question}
          </legend>
          {question.options.map((option) => {
            const value = option.value ?? option.label;
            const selected = isPendingUserInputOptionSelected(question, seeded[question.id], value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                className={cn(
                  "flex w-full cursor-pointer flex-col rounded-md border px-3 py-1.5 text-left hover:bg-accent/60 disabled:cursor-default disabled:opacity-64",
                  selected ? "border-primary/50 bg-primary/8" : "border-input bg-background/40",
                )}
                onClick={() =>
                  update(
                    question.id,
                    togglePendingUserInputOptionSelection(question, seeded[question.id], value),
                  )
                }
              >
                <span>{option.label}</span>
                {option.description !== option.label ? (
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                ) : null}
              </button>
            );
          })}
          {question.allowCustomAnswer === false ? null : (
            <Textarea
              size="sm"
              rows={1}
              aria-label={`Your answer: ${question.header}`}
              placeholder="Or type an answer"
              value={seeded[question.id]?.customAnswer ?? ""}
              onChange={(event) =>
                update(
                  question.id,
                  setPendingUserInputCustomAnswer(
                    question,
                    seeded[question.id],
                    event.target.value,
                  ),
                )
              }
            />
          )}
        </fieldset>
      ))}
      {alert}
      <div className="flex justify-end gap-2">
        {need.userInput.dismissible ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled}
            onClick={() =>
              void run(
                () => dismiss({ environmentId, input: { threadId, requestId } }),
                "Failed to dismiss the question.",
                () => {},
              )
            }
          >
            Dismiss
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={disabled || answers === null}
          onClick={() =>
            answers &&
            void run(
              () => respond({ environmentId, input: { threadId, requestId, answers } }),
              "Failed to submit your answer.",
              () => onAnswered(Object.values(answers).flat().join(", ")),
            )
          }
        >
          Send
        </Button>
      </div>
    </div>
  );
}

function ReportAnswer({
  need,
  onAnswered,
}: {
  need: Extract<ProjectNeed, { kind: "report" }>;
  onAnswered: (answer: string, report: AnsweredReport) => void;
}) {
  const { environmentId, id: threadId, runtimeMode, interactionMode } = need.thread;
  const thread = scopeThreadRef(environmentId, threadId);
  const canOperate = useAtomValue(dismissCoordinatorReport.permissionAtom(environmentId));
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const dismiss = useAtomCommand(dismissCoordinatorReport, { reportFailure: false });
  const [reply, setReply] = useState("");
  const { sending, run, alert } = useAnswerCommand();
  const { messageId, report } = need.report;
  const ref = { messageId, key: report.key, version: report.version };
  const disabled = !canOperate;
  // Sent as the asking thread's next message, so it reaches that thread's agent.
  const sendTurn = (id: MessageId, text: string, reportAnswer?: typeof ref) =>
    startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: id,
          role: "user",
          text,
          attachments: [],
          ...(reportAnswer ? { reportAnswer } : {}),
        },
        runtimeMode,
        interactionMode,
        dispatchMode: "queue",
      },
    });
  const answer = (text: string) => {
    const response: ReportResponse = {
      ref,
      kind: "answer",
      messageId: newMessageId(),
      text: formatReportAnswer(report, text),
      createdAt: new Date().toISOString(),
    };
    void respondToReport(
      thread,
      response,
      () => sendTurn(response.messageId, response.text, ref),
      () => onAnswered(text, { need, response }),
    );
  };
  // A typed reply names the report but does not answer it, so the question stays open.
  const sendReply = () => {
    const text = reply.trim();
    void run(
      () => sendTurn(newMessageId(), formatReportAnswer(report, text)),
      "Failed to send your reply.",
      () => {
        setReply("");
        onAnswered(text, { need });
      },
    );
  };
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <ReportAnswerOptions answers={report.answers ?? []} disabled={disabled} onPick={answer} />
      <Textarea
        size="sm"
        rows={1}
        aria-label={`Reply to ${report.title}`}
        placeholder="Or reply"
        disabled={disabled || sending}
        value={reply}
        onChange={(event) => setReply(event.target.value)}
      />
      {alert}
      <div className="flex justify-end gap-2">
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => {
            const response: ReportResponse = { ref, kind: "dismiss" };
            void respondToReport(
              thread,
              response,
              () =>
                dismiss({
                  environmentId,
                  input: { commandId: CommandId.make(randomUUID()), threadId, ...ref },
                }),
              () => onAnswered("Dismissed", { need, response }),
            );
          }}
        >
          Dismiss
        </Button>
        <Button size="xs" disabled={disabled || sending || reply.trim() === ""} onClick={sendReply}>
          Send
        </Button>
      </div>
    </div>
  );
}
