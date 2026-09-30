import type { EffortControl, ProviderDriverKind } from "@t3tools/contracts";
import { ChevronRightIcon, CircleDollarSignIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { EffortDialSpeedControl } from "./effortDial.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export interface EffortDialStop {
  readonly key: string;
  readonly label: string;
  /** False when nothing available fits the stop. */
  readonly available: boolean;
  /** True when choosing the stop in a started thread switches its model. */
  readonly switchesModel: boolean;
}

export interface EffortDialPanelProps {
  /** Dial levels, or the selected model's own efforts. */
  readonly control: EffortControl;
  readonly stops: ReadonlyArray<EffortDialStop>;
  /** Index into `stops`, or -1 when the selection matches none. */
  readonly selectedIndex: number;
  readonly note: string | null;
  readonly model: {
    readonly driverKind: ProviderDriverKind;
    readonly providerName: string;
    readonly accentColor?: string | undefined;
    readonly name: string;
    readonly effortLabel: string | null;
  };
  readonly speed: EffortDialSpeedControl | null;
  readonly onSelect: (index: number) => void;
  readonly onControlChange: (control: EffortControl) => void;
  readonly onSpeedChange: (value: string) => void;
  readonly onChooseModel: () => void;
}

// The fill cools to warm as effort rises and ends violet, where cost is highest.
const FILL_COLORS = [
  "oklch(0.74 0.12 255)",
  "oklch(0.72 0.14 272)",
  "oklch(0.7 0.16 290)",
  "oklch(0.7 0.18 305)",
] as const;

function SegmentedRow(props: {
  readonly label: string;
  readonly value: string;
  readonly choices: ReadonlyArray<{ value: string; label: string; description?: string }>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 px-2 text-sm">
      <span>{props.label}</span>
      <ToggleGroup
        aria-label={props.label}
        variant="segmented"
        value={[props.value]}
        onValueChange={(value) => {
          const next = value[0];
          if (typeof next === "string") props.onChange(next);
        }}
      >
        {props.choices.map((choice) =>
          choice.description ? (
            <Tooltip key={choice.value}>
              <TooltipTrigger
                render={<Toggle value={choice.value} className="h-6 gap-1 px-2 text-xs" />}
              >
                {choice.label}
                <CircleDollarSignIcon aria-hidden="true" className="size-3 opacity-70" />
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-56">
                {choice.description}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <Toggle key={choice.value} value={choice.value} className="h-6 px-2 text-xs">
              {choice.label}
            </Toggle>
          ),
        )}
      </ToggleGroup>
    </div>
  );
}

/** Effort slider with the model and speed its choice resolves to. */
export function EffortDialPanel(props: EffortDialPanelProps) {
  const count = props.stops.length;
  const index = props.selectedIndex;
  const position = (stopIndex: number) =>
    count > 1 ? `${(stopIndex / (count - 1)) * 100}%` : "0%";
  const fraction = index < 0 || count < 2 ? 0 : index / (count - 1);
  const fillColor = FILL_COLORS[Math.round(fraction * (FILL_COLORS.length - 1))];
  const selectedStop = index < 0 ? undefined : props.stops[index];
  const selectStop = (stopIndex: number) => {
    if (stopIndex !== index && props.stops[stopIndex]?.available) props.onSelect(stopIndex);
  };
  // Thumb and fill move by transform so a change animates without layout.
  const motion = "transition-transform duration-150 ease-out motion-reduce:transition-none";

  return (
    <div className="flex w-72 flex-col p-1.5" data-effort-dial="true">
      <div className="relative mx-4 mt-2 h-5">
        {props.stops.map((stop, stopIndex) =>
          // A model's own efforts are too many to label, so only the chosen one is named.
          props.control === "custom" && stopIndex !== index ? null : (
            <button
              key={stop.key}
              type="button"
              // The range input below owns keyboard focus; the labels are pointer shortcuts.
              tabIndex={-1}
              disabled={!stop.available}
              className={cn(
                "absolute top-0 cursor-pointer whitespace-nowrap text-sm transition-colors duration-150 motion-reduce:transition-none disabled:cursor-default disabled:opacity-40",
                // End labels lean inward so they stay clear of the popover edges.
                stopIndex === 0
                  ? "-translate-x-2"
                  : stopIndex === count - 1
                    ? "-translate-x-[calc(100%-0.5rem)]"
                    : "-translate-x-1/2",
                stopIndex === index
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              style={{ left: position(stopIndex) }}
              onClick={() => selectStop(stopIndex)}
            >
              {stop.label}
            </button>
          ),
        )}
      </div>
      <div className="relative mx-4 mb-1 h-7">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/14" />
        <div
          className={cn("absolute inset-x-0 top-1/2 h-1 origin-left rounded-full", motion)}
          style={{
            transform: `translateY(-50%) scaleX(${fraction})`,
            background: `linear-gradient(90deg, ${FILL_COLORS[0]}, ${fillColor})`,
          }}
        />
        {props.stops.map((stop, stopIndex) => (
          <span
            key={stop.key}
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
                "--dial-ring": `color-mix(in oklab, ${fillColor} 35%, transparent)`,
              } as CSSProperties
            }
          />
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(count - 1, 0)}
          step={1}
          value={Math.max(index, 0)}
          aria-label="Effort"
          aria-valuetext={selectedStop?.label ?? "Custom"}
          className="absolute inset-x-[-0.5rem] inset-y-0 w-[calc(100%+1rem)] cursor-pointer appearance-none bg-transparent opacity-0"
          onChange={(event) => selectStop(Number(event.currentTarget.value))}
          // With nothing selected the input already rests on the first stop,
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
      <SegmentedRow
        label="Effort"
        value={props.control}
        choices={[
          { value: "levels", label: "Levels" },
          { value: "custom", label: "Custom" },
        ]}
        onChange={(value) => props.onControlChange(value === "custom" ? "custom" : "levels")}
      />
      {props.speed ? (
        <SegmentedRow
          label="Speed"
          value={props.speed.value}
          choices={props.speed.choices}
          onChange={props.onSpeedChange}
        />
      ) : null}
    </div>
  );
}
