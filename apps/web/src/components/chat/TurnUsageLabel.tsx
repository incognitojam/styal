import type { ClientSettings, ServerProvider } from "@t3tools/contracts";
import {
  deriveProjectionTurnUsage,
  EMPTY_TURN_USAGE,
  meterWheels,
  turnSummaryViews,
  usageFigureShown,
  usageFigureText,
  type TurnRecord,
  type TurnSummaryView,
  type TurnUsageByTurn,
  type TurnUsageView,
} from "@t3tools/shared/turnUsage";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const selectUsageFigure = (settings: ClientSettings) => settings.turnUsageFigure;

/**
 * Turn usage that keeps its identity until a usage activity arrives, so the
 * timeline's shared row context does not change on every streamed activity.
 */
export function useTurnUsage(
  projection: Parameters<typeof deriveProjectionTurnUsage>[0] | null | undefined,
  enabled: boolean,
): TurnUsageByTurn {
  const [previous, setPrevious] = useState(EMPTY_TURN_USAGE);
  const usage =
    enabled && projection ? deriveProjectionTurnUsage(projection, previous) : EMPTY_TURN_USAGE;
  if (usage !== previous) setPrevious(usage);
  return usage;
}

/** Each turn's model and usage, keeping identity while neither changes. */
export function useTurnSummaries(
  byTurnId: ReadonlyMap<string, TurnRecord>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyMap<string, TurnSummaryView> {
  const [previous, setPrevious] = useState<ReadonlyMap<string, TurnSummaryView>>(() => new Map());
  const summaries = turnSummaryViews(byTurnId, providers, previous);
  if (summaries !== previous) setPrevious(summaries);
  return summaries;
}

/**
 * Text whose changed digits roll up once, like a meter's wheels, when it
 * changes under the same `meterKey`. A new key shows the text as it is, so
 * switching threads never rolls.
 */
function MeterText({ text, meterKey }: { text: string; meterKey: string }) {
  const [shown, setShown] = useState({ text, meterKey, previous: null as string | null, roll: 0 });
  if (shown.text !== text || shown.meterKey !== meterKey) {
    setShown({
      text,
      meterKey,
      previous: shown.meterKey === meterKey ? shown.text : null,
      roll: shown.roll + 1,
    });
  }
  const previous = shown.previous;
  if (previous === null) return text;
  return meterWheels(previous, text).map(({ position, text: shownText, before, rolls, order }) => {
    if (!rolls) return <span key={position}>{shownText}</span>;
    const delay = { animationDelay: `${order * 40}ms` };
    return (
      // Clipping moves an inline block's baseline to its bottom edge, so the
      // wheel aligns by its bottom to sit level with the other characters.
      <span
        key={`${shown.roll}:${position}`}
        className="relative inline-block overflow-hidden align-bottom whitespace-pre"
      >
        <span className="inline-block motion-safe:animate-meter-in" style={delay}>
          {shownText}
        </span>
        {before !== undefined ? (
          <span
            aria-hidden="true"
            className="absolute inset-0 hidden motion-safe:block motion-safe:animate-meter-out"
            style={delay}
          >
            {before}
          </span>
        ) : null}
      </span>
    );
  });
}

/**
 * The turn or thread figure in its surroundings' colour, tokens or cost as the
 * user chose; the breakdown opens on hover. With `meterKey`, a changing figure
 * rolls like a meter. `short` drops the token unit where room is tight.
 */
export function TurnUsageLabel({
  view,
  subject = "Turn usage",
  meterKey,
  short = false,
}: {
  view: TurnUsageView;
  /** Names the figure for screen readers. */
  subject?: string;
  /** Identifies what the figure counts, e.g. the thread; see `MeterText`. */
  meterKey?: string;
  short?: boolean;
}) {
  const figure = useClientSettings(selectUsageFigure);
  const text = usageFigureText(view, figure, short);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        aria-label={`${subject}: ${usageFigureText(view, figure)}`}
        render={
          <button
            type="button"
            className="shrink-0 cursor-default rounded-sm text-xs tabular-nums outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {meterKey !== undefined ? (
          // Changing between tokens and cost, or to the short form, is not a reading changing.
          <MeterText
            text={text}
            meterKey={`${meterKey}:${usageFigureShown(view, figure)}:${short}`}
          />
        ) : (
          text
        )}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="top"
        align="start"
        padding="none"
        className="w-max min-w-56 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-2xs leading-4">
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
            <p key={note} className="w-0 min-w-full text-pretty text-secondary-label text-2xs">
              {note}
            </p>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
