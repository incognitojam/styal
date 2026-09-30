import type { ProviderDriverKind } from "@t3tools/contracts";
import {
  EFFORT_DIAL_LEVEL_LABELS,
  EFFORT_DIAL_LEVELS,
  type EffortDialLevel,
} from "@t3tools/shared/effortDial";
import { ChevronRightIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { EffortDialSpeedControl } from "./effortDial.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export interface EffortDialStop {
  readonly level: EffortDialLevel;
  /** False when nothing available fits the level. */
  readonly available: boolean;
  /** True when choosing the level in a started thread switches its model. */
  readonly switchesModel: boolean;
}

export interface EffortDialPanelProps {
  readonly stops: ReadonlyArray<EffortDialStop>;
  readonly level: EffortDialLevel | null;
  readonly note: string | null;
  readonly model: {
    readonly driverKind: ProviderDriverKind;
    readonly providerName: string;
    readonly accentColor?: string | undefined;
    readonly name: string;
    readonly effortLabel: string | null;
  };
  readonly speed: EffortDialSpeedControl | null;
  readonly onLevelChange: (level: EffortDialLevel) => void;
  readonly onSpeedChange: (value: string) => void;
  readonly onChooseModel: () => void;
}

// The fill cools to warm as effort rises and ends violet at ultra, where cost is highest.
const FILL_COLORS: Readonly<Record<EffortDialLevel, string>> = {
  light: "oklch(0.74 0.12 255)",
  standard: "oklch(0.72 0.14 272)",
  deep: "oklch(0.7 0.16 290)",
  ultra: "oklch(0.7 0.18 305)",
};

/** Slider over the dial's four levels, with the model and speed the chosen level resolves to. */
export function EffortDialPanel(props: EffortDialPanelProps) {
  const index = props.level === null ? -1 : EFFORT_DIAL_LEVELS.indexOf(props.level);
  const position = (stopIndex: number) => `${(stopIndex / (EFFORT_DIAL_LEVELS.length - 1)) * 100}%`;
  const fillColor = props.level ? FILL_COLORS[props.level] : undefined;
  const selectStop = (stopIndex: number) => {
    const stop = props.stops[stopIndex];
    if (stop?.available && stop.level !== props.level) props.onLevelChange(stop.level);
  };

  const fraction = index < 0 ? 0 : index / (EFFORT_DIAL_LEVELS.length - 1);
  const selectedStop = index < 0 ? undefined : props.stops[index];
  // Thumb and fill move by transform so a level change animates without layout.
  const motion = "transition-transform duration-150 ease-out motion-reduce:transition-none";

  return (
    <div className="flex w-72 flex-col p-1.5" data-effort-dial="true">
      <div className="relative mx-4 mt-2 h-5">
        {props.stops.map((stop, stopIndex) => (
          <button
            key={stop.level}
            type="button"
            // The range input below owns keyboard focus; the labels are pointer shortcuts.
            tabIndex={-1}
            disabled={!stop.available}
            className={cn(
              "absolute top-0 cursor-pointer whitespace-nowrap text-sm transition-colors duration-150 motion-reduce:transition-none disabled:cursor-default disabled:opacity-40",
              // End labels lean inward so they stay clear of the popover edges.
              stopIndex === 0
                ? "-translate-x-2"
                : stopIndex === props.stops.length - 1
                  ? "-translate-x-[calc(100%-0.5rem)]"
                  : "-translate-x-1/2",
              stopIndex === index
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            style={{ left: position(stopIndex) }}
            onClick={() => selectStop(stopIndex)}
          >
            {EFFORT_DIAL_LEVEL_LABELS[stop.level]}
          </button>
        ))}
      </div>
      <div className="relative mx-4 mb-1 h-7">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/14" />
        <div
          className={cn("absolute inset-x-0 top-1/2 h-1 origin-left rounded-full", motion)}
          style={{
            transform: `translateY(-50%) scaleX(${fraction})`,
            background: `linear-gradient(90deg, ${FILL_COLORS.light}, ${fillColor ?? FILL_COLORS.light})`,
          }}
        />
        {props.stops.map((stop, stopIndex) => (
          <span
            key={stop.level}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150 motion-reduce:transition-none",
              stopIndex < index ? "bg-white/60" : "bg-foreground/28",
              !stop.available && "opacity-30",
              stop.switchesModel &&
                "outline-[1.5px] outline-muted-foreground outline-offset-3 outline-dashed",
            )}
            style={{ left: position(stopIndex) }}
          />
        ))}
        <div
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-0", motion)}
          style={{ transform: `translateX(${fraction * 100}%)` }}
        >
          <span
            className={cn(
              "absolute top-1/2 left-0 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_4px_var(--dial-ring),0_1px_3px_rgb(0_0_0/0.5)] transition-opacity duration-150 motion-reduce:transition-none",
              index < 0 && "opacity-0",
              selectedStop?.switchesModel &&
                "outline-[1.5px] outline-muted-foreground outline-offset-3 outline-dashed",
            )}
            style={
              {
                "--dial-ring": `color-mix(in oklab, ${fillColor ?? FILL_COLORS.light} 35%, transparent)`,
              } as CSSProperties
            }
          />
        </div>
        <input
          type="range"
          min={0}
          max={EFFORT_DIAL_LEVELS.length - 1}
          step={1}
          value={Math.max(index, 0)}
          aria-label="Effort"
          aria-valuetext={props.level ? EFFORT_DIAL_LEVEL_LABELS[props.level] : "Custom"}
          className="absolute inset-x-[-0.5rem] inset-y-0 w-[calc(100%+1rem)] cursor-pointer appearance-none bg-transparent opacity-0"
          onChange={(event) => selectStop(Number(event.currentTarget.value))}
          // With no level selected the input already rests on the first stop,
          // so choosing it fires no change event.
          onClick={(event) => selectStop(Number(event.currentTarget.value))}
        />
      </div>
      {props.note ? (
        <p className="px-2 pb-1 text-warning text-xs leading-snug">{props.note}</p>
      ) : null}
      <div className="mx-1 my-1 h-px bg-border" />
      <button
        type="button"
        className="flex min-h-8 w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
        onClick={props.onChooseModel}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={props.model.driverKind}
            displayName={props.model.providerName}
            accentColor={props.model.accentColor}
            className="size-4"
            iconClassName="size-4"
          />
          <span className="truncate">{props.model.name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
          {props.model.effortLabel ? `${props.model.effortLabel} effort` : null}
          <ChevronRightIcon className="size-3.5 opacity-60" />
        </span>
      </button>
      {props.speed ? (
        <div className="flex min-h-8 items-center justify-between gap-3 px-2 text-sm">
          <span>Speed</span>
          <ToggleGroup
            aria-label="Speed"
            variant="segmented"
            value={[props.speed.value]}
            onValueChange={(value) => {
              const next = value[0];
              if (typeof next === "string") props.onSpeedChange(next);
            }}
          >
            {props.speed.choices.map((choice) => (
              <Toggle key={choice.value} value={choice.value} className="h-6 px-2 text-xs">
                {choice.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      ) : null}
    </div>
  );
}
