import { useState, type ComponentProps } from "react";
import { Pressable, View } from "react-native";
import type { MessageId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { waitingCoordinatorReports } from "@t3tools/client-runtime/coordinator-reports";
import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import type { ReportState } from "./CoordinatorReports";
import { WorkflowRunReviewCard } from "./WorkflowRunReviewCard";

/** Lives apart from CoordinatorReports so the feed never loads the review card's RPC modules. */
export function NeedsYou({
  reports,
  scroll,
  ...reviewProps
}: {
  reports: readonly ReportState[];
  scroll: (id: MessageId) => void;
} & Omit<ComponentProps<typeof WorkflowRunReviewCard>, "run" | "waitingCount"> & {
    runs: readonly ThreadWorkflowRunWatch[];
  }) {
  const [expanded, setExpanded] = useState(false);
  const open = waitingCoordinatorReports(reports);
  const reviewed = reviewProps.runs.filter((run) => run.review !== undefined);
  const run = reviewed[0];
  const count = open.length + (run ? 1 : 0);
  if (!count) return null;
  const visible = expanded ? open : open.slice(0, run ? 2 : 3);
  return (
    <View className="mx-3 mb-2 overflow-hidden rounded-xl bg-secondary">
      <View className="flex-row items-center justify-between px-3 py-1.5">
        <Text className="font-t3-medium text-foreground-secondary">Needs you · {count}</Text>
        {count > 3 ? (
          <Button
            label={expanded ? "Show less" : `Show all ${count}`}
            size="compact"
            tone="text"
            onPress={() => setExpanded(!expanded)}
          />
        ) : null}
      </View>
      {run ? (
        <WorkflowRunReviewCard
          key={`${run.host}/${run.repository}/${run.runId}:${run.review!.environments.map((environment) => environment.id).join(",")}`}
          environmentId={reviewProps.environmentId}
          threadId={reviewProps.threadId}
          run={run}
          waitingCount={reviewed.length}
          stopWatching={reviewProps.stopWatching}
        />
      ) : null}
      {visible.map(({ message }) => (
        <Pressable
          key={message.id}
          accessibilityRole="button"
          onPress={() => scroll(message.id)}
          className="flex-row items-start gap-2 border-t border-border px-3 py-2"
        >
          <View className="mt-2 size-1.5 rounded-full bg-warning-foreground" />
          <View className="min-w-0 flex-1">
            <Text className="text-sm text-foreground" numberOfLines={2}>
              {message.report!.question}
            </Text>
            <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
              {message.report!.title} · v{message.report!.version} ·{" "}
              <RelativeTime timestamp={message.createdAt} />
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}
