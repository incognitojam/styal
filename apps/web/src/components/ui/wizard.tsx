import { CheckIcon } from "lucide-react";
import { type ComponentProps, useLayoutEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { AnimatedHeight } from "../AnimatedHeight";

export function WizardSteps({
  steps,
  currentStep,
  summaries,
  onStepChange,
  isStepDisabled,
}: {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly summaries?: readonly (string | null)[];
  readonly isStepDisabled?: (step: number) => boolean;
  readonly onStepChange?: (step: number) => void;
}) {
  const stepsRef = useRef<HTMLOListElement>(null);
  const previousLayout = useRef<{
    width: number;
    items: Map<string, { left: number; width: number }>;
  } | null>(null);
  const layoutKey = JSON.stringify([steps, currentStep]);
  useLayoutEffect(() => {
    const list = stepsRef.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    const items = Array.from(list.children) as HTMLElement[];
    const next = {
      width: bounds.width,
      items: new Map(
        items.map((item) => {
          const rect = item.getBoundingClientRect();
          return [item.dataset.step!, { left: rect.left - bounds.left, width: rect.width }];
        }),
      ),
    };
    const previous = previousLayout.current;
    previousLayout.current = next;
    if (
      !previous ||
      Math.abs(previous.width - next.width) > 0.5 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;

    // Hold the final grid tracks while pills animate; animated widths must not
    // feed back into auto-sized columns and cause another layout jump.
    list.style.gridTemplateColumns = items
      .map((item) => `${next.items.get(item.dataset.step!)!.width}px`)
      .join(" ");
    const animations = items.flatMap((item) => {
      const to = next.items.get(item.dataset.step!)!;
      const from = previous.items.get(item.dataset.step!);
      if (!from)
        return [
          item.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], {
            duration: 240,
            easing: "ease-out",
          }),
        ];
      if (Math.abs(from.left - to.left) < 0.5 && Math.abs(from.width - to.width) < 0.5) return [];
      return [
        item.animate(
          [
            { transform: `translateX(${from.left - to.left}px)`, width: `${from.width}px` },
            { transform: "translateX(0)", width: `${to.width}px` },
          ],
          { duration: 200, easing: "ease-out" },
        ),
      ];
    });
    let cancelled = false;
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) list.style.removeProperty("grid-template-columns");
    });
    return () => {
      cancelled = true;
      for (const animation of animations) animation.cancel();
      list.style.removeProperty("grid-template-columns");
    };
  }, [layoutKey]);
  const Step = onStepChange ? "button" : "div";
  return (
    // Let long labels such as Preferences use more of the available width.
    <ol
      ref={stepsRef}
      className="grid auto-cols-auto grid-flow-col gap-1 rounded-xl bg-zinc-25 p-1 ring-1 ring-black/5 dark:bg-white/4 dark:ring-white/5"
      role="list"
      aria-label="Setup progress"
    >
      {steps.map((step, index) => (
        <li key={step} data-step={step} className="min-w-0">
          <Step
            {...(onStepChange
              ? { type: "button" as const, disabled: isStepDisabled?.(index) }
              : {})}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:justify-center max-sm:px-2",
              onStepChange &&
                "cursor-pointer hover:bg-card disabled:cursor-default disabled:hover:bg-transparent",
              index === currentStep &&
                "bg-card text-foreground shadow-xs ring-1 ring-black/5 hover:bg-card dark:shadow-none dark:ring-white/5",
            )}
            aria-current={index === currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}${index < currentStep && summaries?.[index] ? `, ${summaries?.[index]}` : ""}`}
            onClick={onStepChange ? () => onStepChange(index) : undefined}
          >
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-sm font-medium ring-1",
                index < currentStep
                  ? "bg-primary text-primary-foreground ring-primary"
                  : index === currentStep
                    ? "bg-primary/10 text-primary ring-primary/30"
                    : "bg-card text-muted-foreground ring-black/10 dark:bg-white/5 dark:ring-white/10",
              )}
              aria-hidden
            >
              {index < currentStep ? <CheckIcon className="size-4 shrink-0" /> : index + 1}
            </span>
            {/* Narrow rails keep only the current label, so the step you are on is
                still named while the rest stay as numbers. */}
            <span
              className={cn(
                "min-w-0 truncate text-sm font-medium",
                index === currentStep ? "text-foreground" : "text-muted-foreground max-sm:hidden",
              )}
            >
              {step}
            </span>
          </Step>
        </li>
      ))}
    </ol>
  );
}

export function WizardPanel({
  className,
  children,
  holdHeight = false,
  animateHeight = true,
  ...props
}: ComponentProps<"div"> & { readonly holdHeight?: boolean; readonly animateHeight?: boolean }) {
  return (
    <div
      data-slot="dialog-panel"
      className={cn(
        "space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
        className,
      )}
      {...props}
    >
      {animateHeight ? (
        <AnimatedHeight holdHeight={holdHeight}>{children}</AnimatedHeight>
      ) : (
        children
      )}
    </div>
  );
}
