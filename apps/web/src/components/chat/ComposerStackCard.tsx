import type { ReactNode } from "react";

import { InlineButton } from "../ui/button";

/**
 * A card in the stack above the composer, such as Needs you or the project page's "Since you last
 * checked": one width, one gap, one header (label · count · detail, action at the end) and one
 * scrolling body, so the stack stays short enough to leave the timeline room on a phone.
 */
export function ComposerStackCard({
  label,
  count,
  detail,
  action,
  footer,
  testId,
  children,
}: {
  label: ReactNode;
  count?: number | undefined;
  detail?: ReactNode;
  action?: { readonly label: string; readonly onClick: () => void } | null | undefined;
  footer?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="mx-auto mb-2 w-full max-w-(--chat-content-max-width)"
      data-composer-stack-card
      data-testid={testId}
    >
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
        <div className="flex min-h-8 items-center justify-between gap-2 border-b border-border/60 px-3 text-muted-foreground text-xs">
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">{label}</span>
            {count === undefined ? null : ` · ${count}`}
            {detail ? <> · {detail}</> : null}
          </span>
          {action ? (
            <InlineButton touchTarget="padded" onClick={action.onClick}>
              {action.label}
            </InlineButton>
          ) : null}
        </div>
        <div className="flex max-h-[min(24rem,30dvh)] flex-col divide-y divide-border/60 overflow-y-auto">
          {children}
        </div>
        {footer}
      </div>
    </div>
  );
}
