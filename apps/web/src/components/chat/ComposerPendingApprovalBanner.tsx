import { feedbackReportFromApproval } from "@t3tools/client-runtime/feedback-report";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import { deriveToolRowPresentation } from "@t3tools/shared/toolRowPresentation";
import { ShieldIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { composerFloatingLayerProps } from "./composerEventScope";
import { FeedbackReportApprovalBanner } from "./FeedbackReportApproval";

const REQUEST_KIND_LABELS = {
  command: { label: "Command approval", detail: "Command" },
  "file-change": { label: "File change approval", detail: "File change" },
  "file-read": { label: "File read approval", detail: "File to read" },
  permission: { label: "App permission approval", detail: "Permission request" },
  "mcp-elicitation": { label: "App access approval", detail: "App access request" },
} satisfies Record<PendingApproval["requestKind"], { label: string; detail: string }>;

/**
 * The fork answers every approval here; timeline rows only show which one is waiting.
 * Its accessible names differ from the row's, which keeps upstream's row locators unambiguous.
 */
export const ComposerPendingApprovalBanner = memo(function ComposerPendingApprovalBanner(props: {
  readonly approval: PendingApproval;
  readonly pendingCount: number;
  readonly isResponding: boolean;
  readonly disabled: boolean;
  readonly onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}) {
  const { approval } = props;
  const canRespond = approval.responseCapability === "live";
  const report = feedbackReportFromApproval(approval);
  if (report) {
    return (
      <FeedbackReportApprovalBanner
        key={approval.requestId}
        report={report}
        requestId={approval.requestId}
        isResponding={props.isResponding}
        canRespond={canRespond}
        disabled={props.disabled}
        options={approval.options}
        onRespondToApproval={props.onRespondToApproval}
      />
    );
  }
  const isAppAccess = approval.requestKind === "mcp-elicitation";
  const tool =
    !isAppAccess && approval.toolName
      ? deriveToolRowPresentation({ toolName: approval.toolName, input: approval.toolInput })
      : undefined;
  const labels = REQUEST_KIND_LABELS[approval.requestKind];
  const label = tool ? `${tool.heading} approval` : labels.label;
  const Detail = isAppAccess ? "span" : "code";
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant="warning" density="spacious">
        <ComposerBanner.Row layout="approval" data-chat-composer-collapsed-controls="true">
          <ComposerBanner.Icon>
            <ShieldIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span
              role="group"
              aria-label={`Answer: ${label}`}
              className="flex min-w-0 flex-1 flex-col items-start gap-1"
            >
              <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
                <span className="shrink-0 font-medium text-warning-foreground">{label}</span>
                {approval.appName ? (
                  <span className="min-w-0 truncate">{approval.appName}</span>
                ) : null}
                {approval.fullAccessOverride ? (
                  <Popover>
                    <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                      {FULL_ACCESS_OVERRIDE_QUESTION}
                    </PopoverTrigger>
                    <PopoverPopup
                      {...composerFloatingLayerProps}
                      aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                      tooltipStyle
                      side="top"
                      className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
                    >
                      {fullAccessOverrideExplanation(approval.fullAccessOverride)}
                    </PopoverPopup>
                  </Popover>
                ) : null}
                {props.pendingCount > 1 ? (
                  <span className="ms-auto shrink-0 tabular-nums">1/{props.pendingCount}</span>
                ) : null}
              </span>
              <Detail
                aria-label={`${tool?.heading ?? labels.detail} to answer`}
                className={cn(
                  "block max-h-40 w-full min-w-0 overflow-auto text-xs whitespace-pre-wrap text-foreground select-text! [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                  isAppAccess ? "font-sans wrap-break-word" : "font-mono wrap-anywhere",
                )}
                data-approval-detail="complete"
                tabIndex={0}
              >
                {canRespond
                  ? approval.detail || label
                  : "Provider process is gone. Interrupt or restart the run to respond."}
              </Detail>
              {approval.reason ? (
                <span className="w-full min-w-0 text-2xs text-muted-foreground select-text wrap-break-word">
                  {approval.reason}
                </span>
              ) : null}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerPendingApprovalActions
              requestId={approval.requestId}
              disabled={props.disabled}
              isResponding={props.isResponding}
              canRespond={canRespond}
              options={approval.options}
              onRespondToApproval={props.onRespondToApproval}
            />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
