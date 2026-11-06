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
import { StyalToolIcon } from "../StyalToolIcon";
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
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

/** The banner offers opening the report and declining; posting is only offered beside the full report. */
export function FeedbackReportApprovalBanner(props: {
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
      <ComposerBanner.Attachment>
        <ComposerBanner.Root
          role="group"
          aria-label={FEEDBACK_REPORT_TITLE}
          density="spacious"
          data-chat-composer-feedback-report="true"
        >
          <ComposerBanner.Row layout="wrap-actions" className="gap-y-1.5">
            <ComposerBanner.Icon>
              <StyalToolIcon className="size-4" />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="min-w-0 text-sm text-foreground">
                Your agent wants to post a public issue on {props.report.repository}
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ComposerPendingApprovalActions
                requestId={props.requestId}
                isResponding={props.isResponding}
                canRespond={props.canRespond}
                disabled={props.disabled}
                options={declineOptions}
                onRespondToApproval={props.onRespondToApproval}
              />
              <Button size="xs" onClick={() => setOpen(true)}>
                {FEEDBACK_REPORT_OPEN_ACTION}
              </Button>
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup ref={popupRef} className="max-w-2xl" initialFocus={popupRef}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <StyalToolIcon className="size-5 shrink-0 text-icon-muted" />
              <DialogTitle>{FEEDBACK_REPORT_TITLE}</DialogTitle>
            </div>
            <DialogDescription>{feedbackReportDescription(props.report)}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <hr className="mb-4 border-t border-dashed border-border" />
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
