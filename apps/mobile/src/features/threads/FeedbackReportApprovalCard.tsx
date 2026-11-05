import { feedbackReportDeclineOptions } from "@t3tools/client-runtime/feedback-report";
import type {
  FeedbackApprovalReport,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Sheet } from "../../components/ui/Sheet";
import { PendingQuestionText } from "./PendingQuestionText";

/** The card offers review and decline; posting is only offered beside the full report. */
export function FeedbackReportApprovalCard(props: {
  readonly report: FeedbackApprovalReport;
  readonly threadRef: ScopedThreadRef;
  readonly requestId: RuntimeRequestId;
  readonly options: ReadonlyArray<ProviderApprovalOption> | undefined;
  readonly disabled: boolean;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}) {
  const [reviewing, setReviewing] = useState(false);
  const button = (option: ProviderApprovalOption) => (
    <Button
      key={option.decision}
      label={option.label}
      tone={option.decision === "accept" ? "primary" : "secondary"}
      disabled={props.disabled}
      onPress={() => void props.onRespond(props.requestId, option.decision)}
    />
  );
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Post a public issue
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">{props.report.title}</Text>
      <Text className="font-sans text-sm text-foreground-secondary">
        On {props.report.repository} as @{props.report.account}
      </Text>
      <View className="flex-row flex-wrap gap-2.5">
        <Button label="Review report" tone="primary" onPress={() => setReviewing(true)} />
        {feedbackReportDeclineOptions(props.options).map(button)}
      </View>
      {reviewing ? (
        <Sheet title="Review report" onClose={() => setReviewing(false)}>
          <ScrollView
            nestedScrollEnabled
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-3 px-5 pt-3 pb-8"
          >
            <Text className="font-sans text-sm text-foreground-secondary">
              This will be public on {props.report.repository}, posted as @{props.report.account}.
            </Text>
            <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
              <Text className="font-t3-bold text-2xl text-foreground">{props.report.title}</Text>
              <View className="h-px bg-border" />
              <PendingQuestionText
                text={props.report.body}
                threadRef={props.threadRef}
                workspaceRoot={null}
              />
            </View>
            <View className="flex-row flex-wrap gap-2.5 pt-2">{props.options?.map(button)}</View>
          </ScrollView>
        </Sheet>
      ) : null}
    </View>
  );
}
