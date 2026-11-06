import {
  FEEDBACK_REPORT_OPEN_ACTION,
  FEEDBACK_REPORT_REQUEST,
  FEEDBACK_REPORT_TITLE,
  feedbackReportDeclineOptions,
  feedbackReportDescription,
} from "@t3tools/client-runtime/feedback-report";
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

/** The card offers opening the report and declining; posting is only offered beside the full report. */
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
      <Text className="font-sans text-sm text-foreground">{FEEDBACK_REPORT_REQUEST}</Text>
      <View className="flex-row flex-wrap gap-2.5">
        {feedbackReportDeclineOptions(props.options).map(button)}
        <Button
          label={FEEDBACK_REPORT_OPEN_ACTION}
          tone="primary"
          onPress={() => setReviewing(true)}
        />
      </View>
      {reviewing ? (
        <Sheet title={FEEDBACK_REPORT_TITLE} onClose={() => setReviewing(false)}>
          <ScrollView
            nestedScrollEnabled
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-3 px-5 pt-3 pb-8"
          >
            <Text className="font-sans text-sm text-foreground-secondary">
              {feedbackReportDescription(props.report)}
            </Text>
            <View className="border-t border-dashed border-border" />
            <Text className="font-t3-bold text-xl text-foreground">{props.report.title}</Text>
            <PendingQuestionText
              text={props.report.body}
              threadRef={props.threadRef}
              workspaceRoot={null}
            />
            <View className="flex-row flex-wrap gap-2.5 pt-2">{props.options?.map(button)}</View>
          </ScrollView>
        </Sheet>
      ) : null}
    </View>
  );
}
