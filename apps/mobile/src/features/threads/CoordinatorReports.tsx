import Animated from "react-native-reanimated";
import { createContext, use, useState, type ComponentProps } from "react";
import { Pressable, View } from "react-native";
import type { CoordinatorReport, MessageId } from "@t3tools/contracts";
import {
  coordinatorReports,
  waitingCoordinatorReports,
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
};
export type ReportState = ReturnType<typeof coordinatorReports<ReportMessage>>[number];
export const CoordinatorReportsContext = createContext<{
  reports: readonly ReportState[];
  canOperate: boolean;
  send: (text: string, reply: ReportReply) => Promise<void>;
  reply: (reply: ReportReply) => void;
  dismiss: (reply: ReportReply) => Promise<void>;
} | null>(null);

export function CoordinatorReportMessage({
  id,
  children,
  ...props
}: ComponentProps<typeof Animated.View> & { id: MessageId }) {
  const ctx = use(CoordinatorReportsContext);
  const report = ctx?.reports.find((report) => report.message.id === id);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      <View className="mb-2 flex-row items-center gap-2">
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
    <View className="mb-3 gap-2 border-l-2 border-primary pl-3">
      <Text className="font-t3-medium text-foreground-secondary">
        Report · {tag.title} · version {tag.version}
      </Text>
      {report.state === "replaced" ? (
        <Text className="text-foreground-secondary">A newer version is below</Text>
      ) : null}
      {content}
      {report.state === "open" ? (
        <View className="gap-2 rounded-xl bg-secondary p-3">
          <Text className="font-t3-medium text-foreground">{tag.question}</Text>
          <View className="flex-row flex-wrap gap-2">
            {tag.answers?.map((answer, index) => (
              <Button
                key={answer}
                label={answer}
                size="compact"
                tone={index === 0 ? "primary" : "secondary"}
                disabled={!ctx.canOperate || sending}
                onPress={() => run(() => ctx.send(answer, reply))}
              />
            ))}
            <Button
              label="Reply…"
              size="compact"
              tone="text"
              disabled={!ctx.canOperate || sending}
              onPress={() => ctx.reply(reply)}
            />
            <Button
              label="Dismiss"
              size="compact"
              tone="text"
              disabled={!ctx.canOperate || sending}
              onPress={() => run(() => ctx.dismiss(reply))}
            />
          </View>
          {error ? (
            <Text accessibilityRole="alert" className="text-danger">
              {error}
            </Text>
          ) : null}
        </View>
      ) : report.state === "answered" || report.state === "dismissed" ? (
        <Text className="text-foreground-secondary">
          {report.state === "answered"
            ? `You answered: ${report.answer?.text.replace(/^\[[^\n]+\] /, "") ?? ""}`
            : "Dismissed. The agent hears it on its next turn."}
        </Text>
      ) : null}
    </View>
  );
}

export function WaitingReports({
  reports,
  scroll,
}: {
  reports: readonly ReportState[];
  scroll: (id: MessageId) => void;
}) {
  const open = waitingCoordinatorReports(reports);
  if (!open.length) return null;
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl bg-secondary p-3">
      <Text className="font-t3-medium text-foreground-secondary">
        Waiting on you · {open.length}
      </Text>
      {open.map(({ message }) => (
        <Pressable key={message.id} accessibilityRole="button" onPress={() => scroll(message.id)}>
          <Text className="text-foreground" numberOfLines={1}>
            {message.report!.title} · version {message.report!.version} · {message.report!.question}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
