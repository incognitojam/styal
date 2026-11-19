import { ChevronRightIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

/** The project page's stack: which card is open, or "initial" before the first fold or unfold. */
export type ComposerStackOpen = "initial" | "summary" | "needs" | null;

/** How the stack folds Needs you; on "initial" a single item stays open beside the summary. */
export interface ComposerStackFold {
  readonly folded: boolean;
  readonly initial: boolean;
  readonly onFoldedChange: (folded: boolean) => void;
}

/**
 * A card in the stack above the composer, such as Needs you or the project page's "Since you last
 * checked": one width, one gap, one header (label · count · detail, then `aside` and the action at
 * the end) and one body that scrolls past min(15rem, 25% of the window), so the stack leaves the
 * timeline room on a phone. Folded, only the header shows; the header's label folds and unfolds it.
 */
export function ComposerStackCard({
  label,
  count,
  detail,
  action,
  aside,
  footer,
  folded,
  onFoldedChange,
  headerRef,
  testId,
  children,
}: {
  label: ReactNode;
  count?: number | undefined;
  detail?: ReactNode;
  action?: { readonly label: string; readonly onClick: () => void } | null | undefined;
  /** Shown only in the topmost card of the stack. */
  aside?: ReactNode;
  footer?: ReactNode;
  folded: boolean;
  onFoldedChange: (folded: boolean) => void;
  /** The header's fold button, which stays when the body goes. */
  headerRef?: Ref<HTMLButtonElement>;
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
        <div
          className={cn(
            "flex min-h-8 items-center justify-between gap-2 pe-3 text-muted-foreground text-xs",
            !folded && "border-b border-border/60",
          )}
        >
          <button
            ref={headerRef}
            type="button"
            aria-expanded={!folded}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 self-stretch ps-2 text-left"
            onClick={() => onFoldedChange(!folded)}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 shrink-0", !folded && "rotate-90")}
            />
            <span className="min-w-0 truncate">
              <span className="font-medium text-foreground">{label}</span>
              {count === undefined ? null : ` · ${count}`}
              {detail ? <> · {detail}</> : null}
            </span>
          </button>
          {aside ? (
            <span
              data-composer-stack-aside
              className="flex shrink-0 [[data-composer-stack-card]~[data-composer-stack-card]_&]:hidden"
            >
              {aside}
            </span>
          ) : null}
          {action ? (
            <InlineButton touchTarget="padded" onClick={action.onClick}>
              {action.label}
            </InlineButton>
          ) : null}
        </div>
        {folded ? null : (
          <>
            <ScrollArea radius="none" scrollFade className="h-auto max-h-[min(15rem,25dvh)]">
              <div className="flex flex-col divide-y divide-border/60">{children}</div>
            </ScrollArea>
            {footer}
          </>
        )}
      </div>
    </div>
  );
}
