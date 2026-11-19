import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { formatReportAnswer, type ReportReply } from "@t3tools/client-runtime/coordinator-reports";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createProjectNeedsAtom,
  listProjectNeeds,
  projectNeedSummary,
  type ProjectNeed,
} from "@t3tools/client-runtime/project-needs";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { seedUserInputDraftAnswers } from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  type ScopedThreadRef,
  type ThreadWorkflowRunWatch,
} from "@t3tools/contracts";
import { waitingCoordinatorReports } from "@t3tools/client-runtime/coordinator-reports";
import { useState, type ComponentProps } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { ChildApproval } from "../threads/ChildThreadApprovals";
import { ReportAnswerOptions, type ReportState } from "../threads/CoordinatorReports";
import { WorkflowRunReviewCard } from "../threads/WorkflowRunReviewCard";
import { useProjectChatNeedYou } from "./projectChats";

const projectNeedsAtom = createProjectNeedsAtom(environmentThreadDetails);

type Row =
  | { readonly kind: "run"; readonly run: ThreadWorkflowRunWatch }
  | { readonly kind: "report"; readonly report: ReportState }
  | { readonly kind: "need"; readonly need: ProjectNeed };

/** What the chat's own replies can do: the same actions its feed offers. */
export interface ChatReportActions {
  readonly canOperate: boolean;
  readonly send: (text: string, reply: ReportReply) => Promise<void>;
  readonly reply: (reply: ReportReply) => void;
  readonly replyByVoice: (reply: ReportReply) => void;
}

/**
 * The project chat's Needs you: one line above the composer, opening a sheet that answers the
 * chat's reports and its project's other threads' approvals, questions and reports in place.
 */
export function ProjectNeedsYou({
  chat,
  reports,
  runs,
  actions,
  ...reviewProps
}: {
  readonly chat: ScopedThreadRef;
  readonly reports: readonly ReportState[];
  readonly runs: readonly ThreadWorkflowRunWatch[];
  readonly actions: ChatReportActions;
} & Omit<ComponentProps<typeof WorkflowRunReviewCard>, "run">) {
  const [open, setOpen] = useState(false);
  const threads = useProjectChatNeedYou(chat);
  const needs = useNeeds(threads);
  const rows: Row[] = [
    ...runs.filter((run) => run.review !== undefined).map((run) => ({ kind: "run" as const, run })),
    ...waitingCoordinatorReports(reports).map((report) => ({ kind: "report" as const, report })),
    ...needs.map((need) => ({ kind: "need" as const, need })),
  ];
  if (rows.length === 0) return null;
  const first = rows[0]!;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Needs you, ${rows.length}`}
        accessibilityHint="Opens what the project is waiting on"
        onPress={() => setOpen(true)}
        className="mx-3 mb-2 flex-row items-center gap-2.5 rounded-xl bg-secondary px-3 py-2.5 active:opacity-70"
      >
        <View className="size-2 rounded-full bg-warning-foreground" />
        <Text className="font-t3-medium text-foreground">Needs you · {rows.length}</Text>
        <Text className="flex-1 text-foreground-secondary" numberOfLines={1}>
          {rowSummary(first)}
        </Text>
      </Pressable>
      {open ? (
        <Sheet title="Needs you" onClose={() => setOpen(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="px-4 pb-8"
          >
            {rows.map((row) =>
              row.kind === "run" ? (
                <WorkflowRunReviewCard
                  key={`${row.run.host}/${row.run.repository}/${row.run.runId}`}
                  {...reviewProps}
                  run={row.run}
                />
              ) : row.kind === "report" ? (
                <ChatReportItem
                  key={row.report.message.id}
                  report={row.report}
                  actions={actions}
                  close={() => setOpen(false)}
                />
              ) : (
                <NeedItem key={row.need.key} need={row.need} close={() => setOpen(false)} />
              ),
            )}
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
}

function useNeeds(threads: ReadonlyArray<EnvironmentThreadShell>) {
  const keyOf = (thread: EnvironmentThreadShell) =>
    threadKey(scopeThreadRef(thread.environmentId, thread.id));
  const needs = useAtomValue(projectNeedsAtom(threads.map(keyOf).sort().join("\n")));
  return listProjectNeeds(threads, (thread) => needs.get(keyOf(thread)) ?? null);
}

function rowSummary(row: Row): string {
  switch (row.kind) {
    case "run":
      return "A deployment is waiting for review";
    case "report":
      return row.report.message.report!.question ?? row.report.message.report!.title;
    case "need":
      return projectNeedSummary(row.need);
  }
}

function ItemFrame(props: {
  readonly from: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View className="gap-2 border-b border-border py-3">
      <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
        {props.from} · <RelativeTime timestamp={props.createdAt} />
      </Text>
      <Text className="text-foreground">{props.summary}</Text>
      {props.children}
    </View>
  );
}

function useSend() {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>, failure: string) => {
    setSending(true);
    setError(null);
    void action()
      .catch(() => setError(failure))
      .finally(() => setSending(false));
  };
  const alert =
    error === null ? null : (
      <Text accessibilityRole="alert" className="text-danger-foreground">
        {error}
      </Text>
    );
  return { sending, run, alert };
}

function ChatReportItem(props: {
  readonly report: ReportState;
  readonly actions: ChatReportActions;
  readonly close: () => void;
}) {
  const { sending, run, alert } = useSend();
  const { isAvailable: voiceAvailable } = useGlobalVoiceInput();
  const tag = props.report.message.report!;
  const reply = {
    ref: { messageId: props.report.message.id, key: tag.key, version: tag.version },
    title: tag.title,
  };
  const disabled = !props.actions.canOperate || sending;
  return (
    <ItemFrame
      from={`${tag.title} · report`}
      createdAt={props.report.message.createdAt}
      summary={tag.question ?? tag.title}
    >
      <ReportAnswerOptions
        answers={tag.answers ?? []}
        disabled={disabled}
        onPick={(answer) =>
          run(() => props.actions.send(answer, reply), "Could not send your answer. Try again.")
        }
      />
      <View className="flex-row justify-between">
        {voiceAvailable ? (
          <Button
            label="Reply by voice"
            icon="mic"
            size="compact"
            tone="text"
            disabled={disabled}
            onPress={() => {
              props.close();
              props.actions.replyByVoice(reply);
            }}
          />
        ) : (
          <View />
        )}
        <Button
          label="Reply…"
          size="compact"
          tone="text"
          disabled={disabled}
          onPress={() => {
            props.close();
            props.actions.reply(reply);
          }}
        />
      </View>
      {alert}
    </ItemFrame>
  );
}

function NeedItem(props: { readonly need: ProjectNeed; readonly close: () => void }) {
  const navigation = useNavigation();
  const { need } = props;
  const openThread = () => {
    props.close();
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(need.thread.environmentId),
        threadId: String(need.thread.id),
      }),
    );
  };
  if (need.kind === "approval") {
    return (
      <View className="-mx-3.5 border-b border-border">
        <ChildApproval
          entry={{
            thread: scopeThreadRef(need.thread.environmentId, need.thread.id),
            title: need.thread.title,
            approval: need.approval,
          }}
        />
      </View>
    );
  }
  return (
    <ItemFrame
      from={`${need.thread.title}${need.kind === "report" ? " · report" : ""}`}
      createdAt={need.createdAt}
      summary={projectNeedSummary(need)}
    >
      {need.kind === "report" ? (
        <ThreadReportAnswer need={need} />
      ) : need.kind === "question" ? (
        <QuestionAnswer need={need} />
      ) : null}
      <View className="flex-row">
        <Button label="Open thread" size="compact" tone="text" onPress={openThread} />
      </View>
    </ItemFrame>
  );
}

/** The answer is the asking thread's next message, so it reaches that thread's agent. */
function ThreadReportAnswer(props: { readonly need: Extract<ProjectNeed, { kind: "report" }> }) {
  const { environmentId, id: threadId, runtimeMode, interactionMode } = props.need.thread;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const { sending, run, alert } = useSend();
  const { messageId, report } = props.need.report;
  const send = (answer: string) =>
    run(async () => {
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: MessageId.make(uuidv4()),
            role: "user",
            text: formatReportAnswer(report, answer),
            attachments: [],
            reportAnswer: { messageId, key: report.key, version: report.version },
          },
          runtimeMode,
          interactionMode,
          dispatchMode: "queue",
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) throw result;
    }, "Could not send your answer. Try again.");
  return (
    <>
      <ReportAnswerOptions
        answers={report.answers ?? []}
        disabled={!canOperate || sending}
        onPick={send}
      />
      {alert}
    </>
  );
}

/** A one-question request whose options answer it in one tap; anything else opens the thread. */
function QuestionAnswer(props: { readonly need: Extract<ProjectNeed, { kind: "question" }> }) {
  const { environmentId, id: threadId } = props.need.thread;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const { sending, run, alert } = useSend();
  const { requestId, questions, responseCapability } = props.need.userInput;
  const question = questions.length === 1 ? questions[0] : undefined;
  if (question === undefined || question.options.length === 0) return null;
  const seeded = seedUserInputDraftAnswers(questions, {});
  const disabled = !canOperate || sending || responseCapability === "not_resumable";
  return (
    <>
      {question.options.map((option) => {
        const value = option.value ?? option.label;
        return (
          <Pressable
            key={value}
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => {
              const answers = buildPendingUserInputAnswers(questions, {
                ...seeded,
                [question.id]: togglePendingUserInputOptionSelection(
                  question,
                  seeded[question.id],
                  value,
                ),
              });
              if (answers === null) return;
              run(async () => {
                const result = await respond({
                  environmentId,
                  input: { threadId, requestId, answers },
                });
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) throw result;
              }, "Could not send your answer. Try again.");
            }}
            className="rounded-lg border border-border px-3 py-2 active:opacity-70 disabled:opacity-50"
          >
            <Text className="text-foreground">{option.label}</Text>
            {option.description && option.description !== option.label ? (
              <Text className="text-xs text-foreground-secondary">{option.description}</Text>
            ) : null}
          </Pressable>
        );
      })}
      {alert}
    </>
  );
}
