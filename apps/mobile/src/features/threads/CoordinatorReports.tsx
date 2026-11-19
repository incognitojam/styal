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
  reportAnswerDisplay,
  type ReportReply,
} from "@t3tools/client-runtime/coordinator-reports";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";

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
  /** The report whose answers are pinned above the composer; its card leaves them out. */
  pinned: MessageId | null;
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
  const content = <Animated.View {...props}>{children}</Animated.View>;
  if (!ctx || !report) return content;
  const tag = report.message.report!;
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
      {report.state === "open" ? (
        ctx.pinned === id ? null : (
          <ReportAnswerBlock report={report} />
        )
      ) : report.state === "answered" && report.answer ? (
        <AnsweredReport
          answer={report.answer}
          display={reportAnswerDisplay(report.answer, tag)}
          renderAnswer={renderAnswer}
        />
      ) : report.state === "dismissed" ? (
        <Text className="text-foreground-secondary">
          Dismissed. The agent hears it on its next turn.
        </Text>
      ) : null}
    </View>
  );
}

function replyTo(report: ReportState): ReportReply {
  const tag = report.message.report!;
  return {
    ref: { messageId: report.message.id, key: tag.key, version: tag.version },
    title: tag.title,
  };
}

/**
 * An open report's question and answers, with Reply… and Dismiss: inside its card, or pinned
 * above the composer.
 */
export function ReportAnswerBlock(props: {
  readonly report: ReportState;
  readonly onReplyByVoice?: ((reply: ReportReply) => void) | undefined;
  readonly onReply?: (() => void) | undefined;
  /** Under the pinned panel's own header line. */
  readonly pinned?: boolean;
}) {
  const ctx = use(CoordinatorReportsContext)!;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tag = props.report.message.report!;
  const reply = replyTo(props.report);
  const disabled = !ctx.canOperate || sending;
  const run = (action: () => Promise<void>) => {
    setSending(true);
    setError(null);
    void action()
      .catch(() => setError("Could not save your response. Try again."))
      .finally(() => setSending(false));
  };
  return (
    <View className={`gap-2 rounded-xl bg-secondary p-3${props.pinned ? " pt-0" : ""}`}>
      <Text className="font-t3-medium text-foreground">{tag.question}</Text>
      <ReportAnswerOptions
        answers={tag.answers ?? []}
        disabled={disabled}
        onPick={(answer) => run(() => ctx.send(answer, reply))}
      />
      <View className="flex-row items-center justify-between">
        <View className="flex-row">
          <Button
            label="Reply…"
            size="compact"
            tone="text"
            disabled={disabled}
            onPress={() => {
              ctx.reply(reply);
              props.onReply?.();
            }}
          />
          {props.onReplyByVoice ? (
            <Button
              label="Reply by voice"
              icon="mic"
              size="compact"
              tone="text"
              disabled={disabled}
              onPress={() => props.onReplyByVoice?.(reply)}
            />
          ) : null}
        </View>
        <Button
          label="Dismiss"
          size="compact"
          tone="text"
          disabled={disabled}
          onPress={() => run(() => ctx.dismiss(reply))}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A report opened from Needs you: its answers stay above the composer while its body is read
 * in the feed. It keeps to the version opened; a newer one is offered, never swapped in.
 */
export function PinnedReport(props: {
  readonly id: MessageId;
  readonly onClose: () => void;
  readonly onShowLatest: (id: MessageId) => void;
  readonly onReplyByVoice?: ((reply: ReportReply) => void) | undefined;
}) {
  const ctx = use(CoordinatorReportsContext);
  const voice = useGlobalVoiceInput();
  const report = ctx?.reports.find((entry) => entry.message.id === props.id);
  if (!ctx || !report) return null;
  const tag = report.message.report!;

  return (
    <View className="mx-3 mb-2 overflow-hidden rounded-xl bg-secondary">
      <View className="flex-row items-center gap-2 pl-3">
        <Text className="flex-1 text-xs text-foreground-secondary" numberOfLines={1}>
          Report · {tag.title} · version {tag.version}
        </Text>
        <Button label="Close" size="compact" tone="text" onPress={props.onClose} />
      </View>
      {report.state === "open" ? (
        <ReportAnswerBlock
          pinned
          report={report}
          // Hidden where dictation can't start, and while a recording is under way.
          onReplyByVoice={voice.isAvailable && !voice.isBusy ? props.onReplyByVoice : undefined}
        />
      ) : (
        <View className="flex-row items-center gap-2 p-3 pt-0">
          <Text className="flex-1 text-foreground">
            {report.state === "replaced"
              ? "A newer version of this report arrived."
              : report.state === "dismissed"
                ? "Dismissed."
                : "Answered."}
          </Text>
          {report.state === "replaced" ? (
            <Button
              label="Show latest"
              size="compact"
              tone="text"
              onPress={() => props.onShowLatest(report.latest.id)}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

/** A report's answers, the first one recommended; picking one sends it. */
export function ReportAnswerOptions(props: {
  readonly answers: readonly string[];
  readonly disabled: boolean;
  readonly onPick: (answer: string) => void;
}) {
  return props.answers.map((answer, index) => (
    <Pressable
      key={answer}
      accessibilityRole="button"
      accessibilityLabel={index === 0 ? `${answer}, recommended` : answer}
      disabled={props.disabled}
      onPress={() => props.onPick(answer)}
      className={`flex-row items-start gap-2 rounded-lg border px-3 py-2 active:opacity-70 disabled:opacity-50 ${index === 0 ? "border-primary bg-primary/10" : "border-border"}`}
    >
      <Text className="flex-1 text-foreground">{answer}</Text>
      {index === 0 ? <Text className="text-xs text-primary-text">Recommended</Text> : null}
    </Pressable>
  ));
}

function AnsweredReport(props: {
  answer: ReportMessage;
  display: { text: string; compact: boolean };
  renderAnswer: (answer: ReportMessage, text: string) => ReactNode;
}) {
  if (props.display.compact)
    return <Text className="text-foreground-secondary">You answered: {props.display.text}</Text>;
  return (
    <View className="gap-1 rounded-xl bg-secondary p-3">
      <Text className="text-foreground-secondary">You answered</Text>
      {props.renderAnswer(props.answer, props.display.text)}
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
