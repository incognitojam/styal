import {
  FEEDBACK_REPORT_OPEN_ACTION,
  FEEDBACK_REPORT_TITLE,
  feedbackReportDeclineOptions,
  feedbackReportDescription,
} from "@t3tools/client-runtime/feedback-report";
import type {
  FeedbackApprovalReport,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

/** The row offers opening the report and declining; posting is only offered beside the full report. */
export function FeedbackReportApprovalActions(props: {
  readonly report: FeedbackApprovalReport;
  readonly requestId: RuntimeRequestId;
  readonly isResponding: boolean;
  readonly canRespond: boolean;
  readonly disabled: boolean;
  readonly options: ReadonlyArray<ProviderApprovalOption> | undefined;
  readonly onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  // The default target is the code block's first control, which would open its tooltip.
  const popupRef = useRef<HTMLDivElement>(null);
  const declineOptions = feedbackReportDeclineOptions(props.options);
  return (
    <>
      <ComposerPendingApprovalActions
        presentation="inline"
        requestId={props.requestId}
        isResponding={props.isResponding}
        canRespond={props.canRespond}
        disabled={props.disabled}
        options={declineOptions}
        onRespondToApproval={props.onRespondToApproval}
      />
      <InlineButton onClick={() => setOpen(true)}>{FEEDBACK_REPORT_OPEN_ACTION}</InlineButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup ref={popupRef} className="max-w-2xl" initialFocus={popupRef}>
          <DialogHeader>
            <DialogTitle>{FEEDBACK_REPORT_TITLE}</DialogTitle>
            <DialogDescription>{feedbackReportDescription(props.report)}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <h3 className="mb-3 text-xl font-semibold wrap-break-word">{props.report.title}</h3>
            <ChatMarkdown
              text={props.report.body}
              cwd={undefined}
              lineBreaks
              parseRawHtml={false}
            />
          </DialogPanel>
          <DialogFooter>
            <ComposerPendingApprovalActions
              requestId={props.requestId}
              isResponding={props.isResponding}
              canRespond={props.canRespond}
              disabled={props.disabled}
              options={[
                ...declineOptions,
                ...(props.options ?? []).filter((option) => option.decision === "accept"),
              ]}
              onRespondToApproval={props.onRespondToApproval}
            />
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
