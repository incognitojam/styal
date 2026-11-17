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
  runs,
  ...reviewProps
}: {
  reports: readonly ReportState[];
  scroll: (id: MessageId) => void;
  runs: readonly ThreadWorkflowRunWatch[];
} & Omit<ComponentProps<typeof WorkflowRunReviewCard>, "run">) {
  const [expanded, setExpanded] = useState(false);
  const rows = [
    ...runs.filter((run) => run.review !== undefined).map((run) => ({ kind: "run" as const, run })),
    ...waitingCoordinatorReports(reports).map((report) => ({ kind: "report" as const, report })),
  ];
  if (!rows.length) return null;
  const visible = expanded ? rows : rows.slice(0, 3);
  return (
    <View className="mx-3 mb-2 overflow-hidden rounded-xl bg-secondary">
      <View className="flex-row items-center justify-between px-3 py-1.5">
        <Text className="font-t3-medium text-foreground-secondary">Needs you · {rows.length}</Text>
        {rows.length > 3 ? (
          <Button
            label={expanded ? "Show less" : `Show all ${rows.length}`}
            size="compact"
            tone="text"
            onPress={() => setExpanded(!expanded)}
          />
        ) : null}
      </View>
      {visible.map((row, index) =>
        row.kind === "run" ? (
          <WorkflowRunReviewCard
            key={`${row.run.host}/${row.run.repository}/${row.run.runId}:${row.run.review!.environments.map((environment) => environment.id).join(",")}`}
            environmentId={reviewProps.environmentId}
            threadId={reviewProps.threadId}
            run={row.run}
            // The thread's background-work actions belong to the first run only.
            stopWatching={index === 0 ? reviewProps.stopWatching : undefined}
          />
        ) : (
          <Pressable
            key={row.report.message.id}
            accessibilityRole="button"
            onPress={() => scroll(row.report.message.id)}
            className="flex-row items-start gap-2 border-t border-border px-3 py-2"
          >
            <View className="mt-2 size-1.5 rounded-full bg-warning-foreground" />
            <View className="min-w-0 flex-1">
              <Text className="text-sm text-foreground" numberOfLines={2}>
                {row.report.message.report!.question}
              </Text>
              <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
                {row.report.message.report!.title} · v{row.report.message.report!.version} ·{" "}
                <RelativeTime timestamp={row.report.message.createdAt} />
              </Text>
            </View>
          </Pressable>
        ),
      )}
    </View>
  );
}
