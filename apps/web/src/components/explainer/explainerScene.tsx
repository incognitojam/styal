import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/*
 * Simplified drawings for feature explainers. They take theme tokens, not real
 * components, so a scene stays a pure function of its step. Every change is an
 * opacity transition: nothing moves, and nothing runs once a slide rests.
 */

const FADE = "transition-opacity duration-200 ease-out motion-reduce:transition-none";

function Stage({ children }: { readonly children: ReactNode }) {
  return (
    <div
      aria-hidden
      className="relative flex h-76 flex-col items-center justify-center gap-3 overflow-hidden rounded-xl px-4 explainer-stage max-sm:h-80 max-sm:justify-start max-sm:px-3 max-sm:pt-10"
    >
      {children}
    </div>
  );
}

function Window({
  icon,
  title,
  meta,
  footer,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly meta: ReactNode;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="w-full max-w-md overflow-hidden rounded-xl border bg-card text-xs text-foreground shadow-lg dark:shadow-black/70">
      <div className="flex h-10 items-center gap-2 border-b px-3">
        <span className="grid size-5.5 place-items-center rounded-md explainer-tile-soft [&_svg]:size-3.5">
          {icon}
        </span>
        <span className="font-medium">{title}</span>
        <span className="ms-auto text-muted-foreground">{meta}</span>
      </div>
      {children}
      <div className="flex h-8.5 items-center border-t px-3 text-muted-foreground">{footer}</div>
    </div>
  );
}

/** Several texts in one cell; only the one at `shown` is visible, and they crossfade. */
function Swap({
  shown,
  align = "start",
  items,
}: {
  readonly shown: number;
  readonly align?: "start" | "end";
  readonly items: readonly ReactNode[];
}) {
  return (
    <span className="inline-grid">
      {items.map((child, index) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- the cells are a fixed list in a fixed order
          key={index}
          className={cn(
            "col-start-1 row-start-1 inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3",
            align === "end" && "justify-end",
            FADE,
            index === shown ? "opacity-100" : "opacity-0",
          )}
        >
          {child}
        </span>
      ))}
    </span>
  );
}

/** A button-like chip under the window; `pressed` fades in its primary face. */
function Chip({
  icon,
  label,
  pressed = false,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly pressed?: boolean;
}) {
  const face =
    "inline-flex h-7 items-center gap-1.5 px-2.5 max-sm:h-6 max-sm:gap-1 max-sm:px-1.5 [&_svg]:size-3";
  return (
    <span className="relative shrink-0 rounded-lg border bg-card text-xs font-medium whitespace-nowrap text-foreground shadow-xs max-sm:text-2xs">
      <span className={cn(face, "[&_svg]:text-muted-foreground")}>
        {icon}
        {label}
      </span>
      <span
        className={cn(
          face,
          "absolute -inset-px rounded-lg bg-primary text-primary-foreground",
          FADE,
          pressed ? "opacity-100" : "opacity-0",
        )}
      >
        {icon}
        {label}
      </span>
    </span>
  );
}

export const Scene = { Stage, Window, Swap, Chip, FADE };
