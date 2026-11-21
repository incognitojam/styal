import Animated from "react-native-reanimated";
import { createContext, use, useState, type ComponentProps, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import type {
  ChatAttachment,
  CoordinatorReport,
  CoordinatorReportReference,
  MessageId,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import {
  coordinatorReports,
  answeredReportResult,
  reportAnswerDisplay,
  type ReportReply,
} from "@t3tools/client-runtime/coordinator-reports";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

type ReportMessage = {
  id: MessageId;
  role: string;
  text: string;
  createdAt: string;
  report?: CoordinatorReport;
  reportAnswer?: typeof CoordinatorReportReference.Type;
  context?: OrchestrationMessageContext;
  attachments?: readonly ChatAttachment[];
};
export type ReportState = ReturnType<typeof coordinatorReports<ReportMessage>>[number];
export type ReportAnswers = ReadonlyMap<
  MessageId,
  {
    readonly messageId: MessageId;
    readonly title: string;
    readonly version: number;
    readonly text: string;
  }
>;
export const CoordinatorReportsContext = createContext<{
  reports: readonly ReportState[];
  answers: ReportAnswers;
  target: string | null;
  opened: ReadonlySet<MessageId>;
  scroll: (id: MessageId) => void;
  canOperate: boolean;
  send: (text: string, reply: ReportReply) => Promise<void>;
  reply: (reply: ReportReply) => void;
  dismiss: (reply: ReportReply) => Promise<void>;
} | null>(null);

export function CoordinatorReportMessage({
  id,
  children,
  renderAnswer,
  ...props
}: ComponentProps<typeof Animated.View> & {
  id: MessageId;
  /** Renders a typed reply the way its user bubble does, with context chips and line breaks. */
  renderAnswer: (answer: ReportMessage, text: string) => ReactNode;
}) {
  const ctx = use(CoordinatorReportsContext);
  const report = ctx?.reports.find((report) => report.message.id === id);
  const [expanded, setExpanded] = useState(false);
  // Opening a reply chip or waiting row for an older version shows it, not its folded line.
  if (!expanded && (ctx?.target === id || ctx?.opened.has(id))) setExpanded(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A resolved question asks again here until the person answers or cancels.
  const [reopened, setReopened] = useState(false);
  const content = <Animated.View {...props}>{children}</Animated.View>;
  if (!ctx || !report) return content;
  const tag = report.message.report!;
  const reply = { ref: { messageId: id, key: tag.key, version: tag.version }, title: tag.title };
  const run = (action: () => Promise<void>) => {
    setSending(true);
    setError(null);
    void action()
      .catch(() => setError("Could not save your response. Try again."))
      .finally(() => setSending(false));
  };
  if (report.state === "replaced" && !expanded)
    return (
      <View className="mb-2 mt-3 flex-row items-center gap-2 border-l-2 border-border pl-3">
        <View className="flex-1 flex-row">
          <Text className="shrink text-foreground-secondary" numberOfLines={1}>
            {tag.title}
          </Text>
          <Text className="shrink-0 text-foreground-secondary"> · version {tag.version}</Text>
        </View>
        <Button label="Show" size="compact" tone="text" onPress={() => setExpanded(true)} />
      </View>
    );
  return (
    <View
      className={`mb-3 mt-3 gap-2 border-l-2 pl-3 ${report.state === "replaced" ? "border-border" : "border-primary"}`}
    >
      <Text className="font-t3-medium text-foreground-secondary">
        Report · {tag.title} · version {tag.version}
      </Text>
      {report.state === "replaced" ? (
        <Text className="text-warning-foreground">A newer version is below</Text>
      ) : null}
      {content}
      {report.state === "open" || (report.state === "resolved" && reopened) ? (
        <View className="gap-2 rounded-xl bg-secondary p-3">
          <Text className="font-t3-medium text-foreground">{tag.question}</Text>
          {tag.answers?.map((answer, index) => (
            <Pressable
              key={answer}
              accessibilityRole="button"
              accessibilityLabel={index === 0 ? `${answer}, recommended` : answer}
              disabled={!ctx.canOperate || sending}
              onPress={() => run(() => ctx.send(answer, reply))}
              className={`flex-row items-start gap-2 rounded-lg border px-3 py-2 active:opacity-70 disabled:opacity-50 ${index === 0 ? "border-primary bg-primary/10" : "border-border"}`}
            >
              <Text className="flex-1 text-foreground">{answer}</Text>
              {index === 0 ? <Text className="text-xs text-primary-text">Recommended</Text> : null}
            </Pressable>
          ))}
          <View className="flex-row justify-between">
            <Button
              label="Reply…"
              size="compact"
              tone="text"
              disabled={!ctx.canOperate || sending}
              onPress={() => ctx.reply(reply)}
            />
            {report.state === "resolved" ? (
              <Button
                label="Cancel"
                size="compact"
                tone="text"
                onPress={() => setReopened(false)}
              />
            ) : (
              <Button
                label="Dismiss"
                size="compact"
                tone="text"
                disabled={!ctx.canOperate || sending}
                onPress={() => run(() => ctx.dismiss(reply))}
              />
            )}
          </View>
          {error ? (
            <Text accessibilityRole="alert" className="text-danger">
              {error}
            </Text>
          ) : null}
        </View>
      ) : report.state === "answered" && report.answer ? (
        <AnsweredReport
          answer={report.answer}
          display={reportAnswerDisplay(report.answer, tag)}
          renderAnswer={renderAnswer}
          outcome={answeredReportResult(tag, report.answer)}
        />
      ) : report.state === "resolved" ? (
        <View className="gap-1 rounded-xl bg-secondary p-3">
          <Text className="text-foreground-secondary">{tag.question}</Text>
          <View className="flex-row items-start justify-between gap-2">
            <Text className="shrink text-foreground-secondary">
              Resolved by the agent
              {tag.resolved?.outcome ? (
                <Text className="text-foreground">: {tag.resolved.outcome}</Text>
              ) : null}
            </Text>
            <Button
              label="Reopen"
              size="compact"
              tone="text"
              disabled={!ctx.canOperate}
              onPress={() => setReopened(true)}
            />
          </View>
        </View>
      ) : report.state === "dismissed" ? (
        <Text className="text-foreground-secondary">
          Dismissed. The agent hears it on its next turn.
        </Text>
      ) : null}
    </View>
  );
}

function AnsweredReport(props: {
  answer: ReportMessage;
  display: { text: string; compact: boolean };
  renderAnswer: (answer: ReportMessage, text: string) => ReactNode;
  outcome: string | undefined;
}) {
  const outcome = props.outcome ? (
    <Text className="text-foreground-secondary">Result: {props.outcome}</Text>
  ) : null;
  if (props.display.compact)
    return (
      <View className="gap-1">
        <Text className="text-foreground-secondary">You answered: {props.display.text}</Text>
        {outcome}
      </View>
    );
  return (
    <View className="gap-1 rounded-xl bg-secondary p-3">
      <Text className="text-foreground-secondary">You answered</Text>
      {props.renderAnswer(props.answer, props.display.text)}
      {outcome}
    </View>
  );
}

/** Names the report a user message answers and opens that report version. */
export function ReportAnswerChip({
  title,
  version,
  onPress,
}: {
  title: string;
  version: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open report ${title}, version ${version}`}
      onPress={onPress}
      className="mb-1 max-w-full flex-row self-start rounded-md bg-primary/15 px-1.5 py-0.5 active:opacity-70"
    >
      <Text className="shrink text-sm text-primary-text" numberOfLines={1}>
        {title}
      </Text>
      <Text className="text-sm text-primary-text"> · v{version}</Text>
    </Pressable>
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
    <View className="mx-3 mb-1 flex-row items-start gap-2 border-b border-border pb-2">
      <View className="w-0.5 self-stretch rounded-full bg-primary" />
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
          Replying to <Text className="text-xs text-foreground">{title}</Text> · v{version}
        </Text>
        {question ? (
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {question}
          </Text>
        ) : null}
      </View>
      <Button label="Cancel" size="compact" tone="text" onPress={onCancel} />
    </View>
  );
}
