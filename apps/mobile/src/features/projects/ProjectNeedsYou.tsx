import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, useRoute } from "@react-navigation/native";
import { waitingCoordinatorReports } from "@t3tools/client-runtime/coordinator-reports";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createProjectNeedsAtom,
  listProjectNeeds,
  projectNeedSummary,
  type ProjectNeed,
} from "@t3tools/client-runtime/project-needs";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { MessageId, ScopedThreadRef, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentThreadDetails } from "../../state/threads";
import { ChildApproval } from "../threads/ChildThreadApprovals";
import type { ReportState } from "../threads/CoordinatorReports";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import { WorkflowRunReviewCard } from "../threads/WorkflowRunReviewCard";
import { useProjectChatNeedYou } from "./projectChats";
import { oldestFirst } from "./projectNeedsYou.logic";

const projectNeedsAtom = createProjectNeedsAtom(environmentThreadDetails);

type Row =
  | { readonly kind: "run"; readonly run: ThreadWorkflowRunWatch }
  | { readonly kind: "report"; readonly report: ReportState }
  | { readonly kind: "need"; readonly need: ProjectNeed };

/**
 * The project chat's Needs you: one line above the composer, opening a list of what the
 * project waits on. A report or a question opens in its thread, where its answers are pinned
 * above the composer; an approval or a deployment review is answered in the list.
 */
export function ProjectNeedsYou({
  chat,
  reports,
  runs,
  openRequest,
  onOpenChatReport,
  barHidden,
  ...reviewProps
}: {
  readonly chat: ScopedThreadRef;
  readonly reports: readonly ReportState[];
  readonly runs: readonly ThreadWorkflowRunWatch[];
  /** Changes when the list should open, such as after an answer made from it. */
  readonly openRequest: string;
  readonly onOpenChatReport: (id: MessageId) => void;
  /** While a report is pinned in its place: the list can still open, the line hides. */
  readonly barHidden: boolean;
} & Omit<ComponentProps<typeof WorkflowRunReviewCard>, "run">) {
  const navigation = useNavigation();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [seenRequest, setSeenRequest] = useState(openRequest);
  const threads = useProjectChatNeedYou(chat);
  const needs = useNeeds(threads);
  const rows = oldestFirst<Row>(
    [
      ...runs
        .filter((run) => run.review !== undefined)
        .map((run) => ({ kind: "run" as const, run })),
      ...waitingCoordinatorReports(reports).map((report) => ({ kind: "report" as const, report })),
      ...needs.map((need) => ({ kind: "need" as const, need })),
    ],
    rowCreatedAt,
    rowKey,
  );
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    if (rows.length > 0) setOpen(true);
  }
  // The list closes with its last item, so the next one shows the bar, not the list.
  if (rows.length === 0 && open) setOpen(false);
  if (rows.length === 0) return null;
  const openInThread = (thread: ScopedThreadRef, reportId: MessageId | null) => {
    setOpen(false);
    if (reportId !== null) {
      requestThreadMessageJump(scopedThreadKey(thread.environmentId, thread.threadId), reportId);
    }
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(thread.environmentId),
        threadId: String(thread.threadId),
        ...(reportId === null ? {} : { report: String(reportId) }),
        fromProject: route.key,
      }),
    );
  };
  return (
    <>
      {barHidden ? null : (
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
            {rowTitle(rows[0]!)}
          </Text>
        </Pressable>
      )}
      {open ? (
        <Sheet title="Needs you" onClose={() => setOpen(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="px-4 pb-8"
          >
            {rows.map((row) =>
              row.kind === "run" ? (
                <WorkflowRunReviewCard key={rowKey(row)} {...reviewProps} run={row.run} />
              ) : row.kind === "need" && row.need.kind === "approval" ? (
                <View key={rowKey(row)} className="-mx-3.5 border-b border-border">
                  <ChildApproval
                    entry={{
                      thread: scopeThreadRef(row.need.thread.environmentId, row.need.thread.id),
                      title: row.need.thread.title,
                      approval: row.need.approval,
                    }}
                  />
                </View>
              ) : (
                <NeedRow
                  key={rowKey(row)}
                  kind={rowKind(row)}
                  title={rowTitle(row)}
                  from={row.kind === "report" ? null : row.need.thread.title}
                  createdAt={rowCreatedAt(row)}
                  onPress={() => {
                    if (row.kind === "report") {
                      setOpen(false);
                      onOpenChatReport(row.report.message.id);
                      return;
                    }
                    const { need } = row;
                    openInThread(
                      scopeThreadRef(need.thread.environmentId, need.thread.id),
                      need.kind === "report" ? need.report.messageId : null,
                    );
                  }}
                />
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

function rowCreatedAt(row: Row): string {
  switch (row.kind) {
    case "run":
      return row.run.startedAt;
    case "report":
      return row.report.message.createdAt;
    case "need":
      return row.need.createdAt;
  }
}

function rowKey(row: Row): string {
  switch (row.kind) {
    case "run":
      return `run:${row.run.host}/${row.run.repository}/${row.run.runId}`;
    case "report":
      return `report:${row.report.message.id}`;
    case "need":
      return `need:${row.need.key}`;
  }
}

function rowKind(row: Row): string {
  if (row.kind === "report") return "Report";
  if (row.kind === "run") return "Deployment review";
  switch (row.need.kind) {
    case "report":
      return "Report";
    case "question":
      return "Question";
    case "approval":
      return "Approval";
    case "thread":
      return "Waiting";
  }
}

/** A report's title, or what a question or request asks. */
function rowTitle(row: Row): string {
  switch (row.kind) {
    case "run":
      return "A deployment is waiting for review";
    case "report":
      return row.report.message.report!.title;
    case "need":
      return row.need.kind === "report"
        ? row.need.report.report.title
        : projectNeedSummary(row.need);
  }
}

function NeedRow(props: {
  readonly kind: string;
  readonly title: string;
  /** The asking thread; null for the chat's own reports. */
  readonly from: string | null;
  readonly createdAt: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.kind, props.title, props.from].filter(Boolean).join(", ")}
      onPress={props.onPress}
      className="flex-row items-center gap-3 border-b border-border py-3 active:opacity-70"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
          {props.kind}
          {props.from ? ` · ${props.from}` : ""} · <RelativeTime timestamp={props.createdAt} />
        </Text>
        <Text className="font-t3-medium text-foreground" numberOfLines={2}>
          {props.title}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={13} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}
