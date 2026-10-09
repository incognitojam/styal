import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveTurnUsage,
  EMPTY_TURN_USAGE,
  type TurnUsageByTurn,
  type TurnUsageView,
} from "@t3tools/shared/turnUsage";
import { useMemo, useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * Turn usage that keeps its identity until a usage activity arrives, so the
 * timeline's shared row context does not change on every streamed activity.
 */
export function useTurnUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  enabled: boolean,
): TurnUsageByTurn {
  const [previous, setPrevious] = useState(EMPTY_TURN_USAGE);
  const usage = useMemo(
    () => (enabled ? deriveTurnUsage(activities, previous) : EMPTY_TURN_USAGE),
    [activities, enabled, previous],
  );
  if (usage !== previous) setPrevious(usage);
  return usage;
}

/** One muted figure; the token breakdown opens on hover. */
export function TurnUsageLabel({ view }: { view: TurnUsageView }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        aria-label={`Turn usage: ${view.headline}`}
        render={
          <button
            type="button"
            className="shrink-0 cursor-default rounded-sm text-muted-foreground/70 text-xs tabular-nums outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {view.headline}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="top"
        align="start"
        padding="none"
        className="w-max min-w-56 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[11px] leading-4">
            {view.rows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="whitespace-nowrap text-secondary-label">{row.label}</dt>
                <dd className="whitespace-nowrap text-right font-medium tabular-nums text-secondary-label">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {/* Notes wrap to the rows' width instead of widening the card. */}
          {view.notes.map((note) => (
            <p key={note} className="w-0 min-w-full text-pretty text-secondary-label text-[11px]">
              {note}
            </p>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
