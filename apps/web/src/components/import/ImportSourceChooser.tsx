import { ChevronRightIcon, FolderIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ClaudeAI, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import type { ImportSource } from "./types";

/**
 * One row per place data can come from. The mark shown here is the same mark the
 * project rows use once the flow is entered, so the choice stays recognisable.
 */
function SourceChoice({
  icon,
  title,
  detail,
  disabled,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-14 w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "hover:border-border hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-64 motion-reduce:transition-none",
      )}
    >
      <span className="flex w-10 shrink-0 items-center justify-center gap-1.5 text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-[1.45] text-muted-foreground">
          {detail}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
    </button>
  );
}

/**
 * First screen of the top-level Projects step, before a source is picked. The
 * Preferences step is discovered independently of this project-source choice.
 * Settings never renders the chooser: only T3 Code migration is offered there.
 */
export function ImportSourceChooser({
  onSelect,
  onSkip,
  busy,
  error,
  skipLabel = "Skip for now",
  skipDisabled = false,
}: {
  onSelect: (source: ImportSource) => void;
  onSkip: () => void;
  busy: boolean;
  error: string | null;
  skipLabel?: string;
  skipDisabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col" aria-busy={busy || undefined}>
      <h2 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
        Bring your projects into styal
      </h2>

      <div className="mt-5 flex min-w-0 flex-col gap-2">
        <SourceChoice
          icon={<FolderIcon className="size-4.5" aria-hidden />}
          title="T3 Code"
          detail="Projects and conversations"
          disabled={busy}
          onClick={() => onSelect("legacy")}
        />
        <SourceChoice
          icon={
            <>
              <ClaudeAI className="size-4" aria-hidden />
              <OpenAI className="size-4" aria-hidden />
            </>
          }
          title="Claude Code / Codex"
          detail="CLI conversation history"
          disabled={busy}
          onClick={() => onSelect("history")}
        />
      </div>

      {error !== null ? (
        <p
          role="alert"
          className="mt-4 flex min-w-0 items-start gap-1.5 text-xs leading-[1.45] text-destructive"
        >
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}

      <div className="mt-6 flex shrink-0 items-center justify-end gap-2 border-t border-border/60 pt-3">
        <Button variant="ghost" onClick={onSkip} disabled={busy || skipDisabled}>
          {busy ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : null}
          {skipLabel}
        </Button>
      </div>
    </div>
  );
}
