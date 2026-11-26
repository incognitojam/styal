import { cn } from "../../lib/utils";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { ShieldIcon } from "lucide-react";

import type { PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { composerFloatingLayerProps } from "./composerEventScope";

const LABELS = {
  command: msg("Command approval"),
  "file-change": msg("File change approval"),
  "file-read": msg("File read approval"),
  permission: msg("App permission approval"),
  "mcp-elicitation": msg("App access approval"),
};

export function ComposerPendingApprovalBanner(props: {
  readonly approval: PendingApproval;
  readonly pendingCount: number;
  readonly isResponding: boolean;
  readonly disabled: boolean;
  readonly onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}) {
  const gt = useGT();
  const m = useMessages();
  const { approval } = props;
  const isAppAccess = approval.requestKind === "mcp-elicitation";
  const label = m(LABELS[approval.requestKind]);
  const canRespond = approval.responseCapability === "live";
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
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
              aria-label={gt("Answer: {label}", { label })}
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
                      {m(FULL_ACCESS_OVERRIDE_QUESTION)}
                    </PopoverTrigger>
                    <PopoverPopup
                      {...composerFloatingLayerProps}
                      aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
                      tooltipStyle
                      side="top"
                      className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
                    >
                      {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
                    </PopoverPopup>
                  </Popover>
                ) : null}
                {props.pendingCount > 1 ? (
                  <span className="ms-auto shrink-0 tabular-nums">1/{props.pendingCount}</span>
                ) : null}
              </span>
              <Detail
                aria-label={gt("Approval details")}
                className={cn(
                  "block max-h-40 w-full min-w-0 overflow-auto text-xs whitespace-pre-wrap text-foreground select-text! [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                  isAppAccess ? "font-sans wrap-break-word" : "font-mono wrap-anywhere",
                )}
                data-approval-detail="complete"
                tabIndex={0}
              >
                {canRespond
                  ? approval.detail || label
                  : gt("Provider process is gone. Interrupt or restart the run to respond.")}
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
}
