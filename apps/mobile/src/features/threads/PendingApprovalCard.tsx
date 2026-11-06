import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { feedbackReportFromApproval } from "@t3tools/client-runtime/feedback-report";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";
import { FeedbackReportApprovalCard } from "./FeedbackReportApprovalCard";

export interface PendingApprovalCardProps {
  readonly threadRef: ScopedThreadRef;
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const report = feedbackReportFromApproval(props.approval);
  if (report !== null) {
    return (
      <FeedbackReportApprovalCard
        report={report}
        threadRef={props.threadRef}
        requestId={props.approval.requestId}
        options={props.approval.options}
        disabled={disabled || !props.canOperateThread}
        onRespond={props.onRespond}
      />
    );
  }
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Approval needed
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.approval.detail}
        </Text>
      ) : null}
      {props.approval.reason ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">
          {props.approval.reason}
        </Text>
      ) : null}
      {props.approval.fullAccessOverride ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: explanationOpen }}
          onPress={() => setExplanationOpen((open) => !open)}
        >
          <Text className="font-t3-bold text-xs text-foreground-secondary underline">
            {FULL_ACCESS_OVERRIDE_QUESTION}
          </Text>
          {explanationOpen ? (
            <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
              {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-adaptive-amber-700-300">
          {warning}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={disabled || !props.canOperateThread}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          />
        ))}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </View>
  );
}
