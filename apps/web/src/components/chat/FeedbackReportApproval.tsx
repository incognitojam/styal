import { feedbackReportDeclineOptions } from "@t3tools/client-runtime/feedback-report";
import type {
  FeedbackApprovalReport,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
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

export function FeedbackReportApprovalPanel(props: { readonly report: FeedbackApprovalReport }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col items-start gap-1" role="group">
      <span className="text-2xs font-medium text-muted-foreground">Post a public issue</span>
      <span className="w-full min-w-0 truncate text-sm text-foreground">{props.report.title}</span>
      <span className="w-full min-w-0 truncate text-2xs text-muted-foreground">
        On {props.report.repository} as @{props.report.account}
      </span>
    </span>
  );
}

/** The banner offers review and decline; posting is only offered beside the full report. */
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
        requestId={props.requestId}
        isResponding={props.isResponding}
        canRespond={props.canRespond}
        disabled={props.disabled}
        options={declineOptions}
        onRespondToApproval={props.onRespondToApproval}
      />
      <Button size="xs" onClick={() => setOpen(true)}>
        Review report
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup ref={popupRef} className="max-w-2xl" initialFocus={popupRef}>
          <DialogHeader>
            <DialogTitle>Review report</DialogTitle>
            <DialogDescription>
              This will be public on {props.report.repository}, posted as @{props.report.account}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <h3 className="border-b border-border pb-3 text-xl font-semibold wrap-break-word">
                {props.report.title}
              </h3>
              <ChatMarkdown
                text={props.report.body}
                cwd={undefined}
                lineBreaks
                parseRawHtml={false}
              />
            </div>
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
