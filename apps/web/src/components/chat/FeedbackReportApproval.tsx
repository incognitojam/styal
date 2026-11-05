import { feedbackReportDeclineOptions } from "@t3tools/client-runtime/feedback-report";
import type {
  FeedbackApprovalReport,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { useState } from "react";

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
      <span className="text-2xs font-medium text-warning">Post a public issue</span>
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
  return (
    <>
      <ComposerPendingApprovalActions
        requestId={props.requestId}
        isResponding={props.isResponding}
        canRespond={props.canRespond}
        disabled={props.disabled}
        options={feedbackReportDeclineOptions(props.options)}
        onRespondToApproval={props.onRespondToApproval}
      />
      <Button size="xs" onClick={() => setOpen(true)}>
        Review report
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{props.report.title}</DialogTitle>
            <DialogDescription>
              This will be public on {props.report.repository}, posted as @{props.report.account}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
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
              options={props.options}
              onRespondToApproval={props.onRespondToApproval}
            />
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
