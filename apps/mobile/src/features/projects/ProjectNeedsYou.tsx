import { useAtomValue } from "@effect/atom-react";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
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
import { useCallback, useRef, useState, type ComponentProps } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { environmentThreadDetails } from "../../state/threads";
import { ChildApproval } from "../threads/ChildThreadApprovals";
import type { ReportState } from "../threads/CoordinatorReports";
import { pendingThreadMessageJump } from "../threads/threadMessageJump";
import { scopedThreadKey } from "../../lib/scopedEntities";
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
  ...reviewProps
}: {
  readonly chat: ScopedThreadRef;
  readonly reports: readonly ReportState[];
  readonly runs: readonly ThreadWorkflowRunWatch[];
} & Omit<ComponentProps<typeof WorkflowRunReviewCard>, "run">) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  // A report opened from the list is on screen: coming back to the chat, however the report
  // screen was left, reopens the list, unless Open thread asked for the report in this chat.
  const reportOpen = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!reportOpen.current) return;
      reportOpen.current = false;
      if (pendingThreadMessageJump(scopedThreadKey(chat.environmentId, chat.threadId)) !== null)
        return;
      setOpen(true);
    }, [chat.environmentId, chat.threadId]),
  );
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
  // The list closes with its last item, so the next one shows the bar, not the list.
  if (rows.length === 0 && open) setOpen(false);
  if (rows.length === 0) return null;
  const openItem = (thread: ScopedThreadRef, reportId: MessageId | null) => {
    setOpen(false);
    reportOpen.current = reportId !== null;
    const ids = { environmentId: String(thread.environmentId), threadId: String(thread.threadId) };
    navigation.dispatch(
      reportId === null
        ? StackActions.push("Thread", ids)
        : StackActions.push("ThreadReport", { ...ids, report: String(reportId) }),
    );
  };
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
          {rowTitle(rows[0]!)}
        </Text>
      </Pressable>
      {open ? (
        <Sheet title="Needs you" fitToContents onClose={() => setOpen(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="px-4"
            // Clear of the home indicator, which the sheet runs under.
            contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          >
            {rows.map((row) =>
              row.kind === "run" ? (
                <WorkflowRunReviewCard key={rowKey(row)} {...reviewProps} run={row.run} />
              ) : row.kind === "need" && row.need.kind === "approval" ? (
                <View key={rowKey(row)} className="gap-1 border-b border-border py-3">
                  <NeedMeta
                    kind="Approval"
                    from={row.need.thread.title}
                    createdAt={rowCreatedAt(row)}
                  />
                  <ChildApproval
                    inList
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
                  question={rowQuestion(row)}
                  from={row.kind === "report" ? null : row.need.thread.title}
                  createdAt={rowCreatedAt(row)}
                  onPress={() => {
                    if (row.kind === "report") {
                      openItem(chat, row.report.message.id);
                      return;
                    }
                    const { need } = row;
                    openItem(
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

/** A report's question; null for other rows, whose title is already what they ask. */
function rowQuestion(row: Row): string | null {
  if (row.kind === "report") return row.report.message.report!.question ?? null;
  if (row.kind === "need" && row.need.kind === "report")
    return row.need.report.report.question ?? null;
  return null;
}

function NeedMeta(props: {
  readonly kind: string;
  /** The asking thread; null for the chat's own reports. */
  readonly from: string | null;
  readonly createdAt: string;
}) {
  return (
    <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
      {props.kind}
      {props.from ? ` · ${props.from}` : ""} · <RelativeTime timestamp={props.createdAt} />
    </Text>
  );
}

function NeedRow(props: {
  readonly kind: string;
  readonly title: string;
  readonly question: string | null;
  readonly from: string | null;
  readonly createdAt: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.kind, props.title, props.question, props.from]
        .filter(Boolean)
        .join(", ")}
      onPress={props.onPress}
      className="flex-row items-center gap-3 border-b border-border py-3 active:opacity-70"
    >
      <View className="min-w-0 flex-1 gap-1">
        <NeedMeta kind={props.kind} from={props.from} createdAt={props.createdAt} />
        <Text className="font-t3-medium text-foreground" numberOfLines={2}>
          {props.title}
        </Text>
        {props.question ? (
          <Text className="text-foreground-secondary" numberOfLines={3}>
            {props.question}
          </Text>
        ) : null}
      </View>
      <SymbolView name="chevron.right" size={13} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}
