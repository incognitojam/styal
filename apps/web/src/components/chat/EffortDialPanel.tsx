import type { EffortControl, ProviderDriverKind } from "@t3tools/contracts";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CircleDollarSignIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

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

interface EffortDialModelIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly providerName: string;
  readonly accentColor?: string | undefined;
  readonly name: string;
}

export interface EffortDialModelRow extends EffortDialModelIdentity {
  readonly key: string;
  readonly selected: boolean;
}

export interface EffortDialPanelProps {
  /** The slider, or the list of models to choose instead of the levels. */
  readonly view: "dial" | "models";
  /** Dial levels ("Default"), or the selected model's own efforts. */
  readonly control: EffortControl;
  readonly stops: ReadonlyArray<EffortDialStop>;
  /** Index into `stops`, or -1 when the selection matches none. */
  readonly selectedIndex: number;
  readonly note: string | null;
  readonly model: EffortDialModelIdentity & { readonly effortLabel: string | null };
  readonly speed: EffortDialSpeedControl | null;
  readonly models: ReadonlyArray<EffortDialModelRow>;
  readonly onSelect: (index: number) => void;
  readonly onSpeedChange: (value: string) => void;
  readonly onViewChange: (view: "dial" | "models") => void;
  readonly onChooseDefault: () => void;
  readonly onChooseModel: (key: string) => void;
  readonly onShowAllModels: () => void;
}

// The fill cools to warm as effort rises and ends violet, where cost is highest.
const FILL_COLORS = [
  "oklch(0.74 0.12 255)",
  "oklch(0.72 0.14 272)",
  "oklch(0.7 0.16 290)",
  "oklch(0.7 0.18 305)",
] as const;
// Half the track height: the thumb's travel is inset by it so the thumb stays inside.
const TRACK_RADIUS = "14px";

function ModelIdentity(props: { readonly model: EffortDialModelIdentity }) {
  return (
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
  );
}

function PanelRow(props: {
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-8 w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
      onClick={props.onClick}
    >
      {props.children}
      {props.trailing ? (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
          {props.trailing}
        </span>
      ) : null}
    </button>
  );
}

function SpeedRow(props: {
  readonly speed: EffortDialSpeedControl;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 px-2 text-sm">
      <span>Speed</span>
      <ToggleGroup
        aria-label="Speed"
        variant="segmented"
        value={[props.speed.value]}
        onValueChange={(value) => {
          const next = value[0];
          if (typeof next === "string") props.onChange(next);
        }}
      >
        {props.speed.choices.map((choice) =>
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

function ModelList(props: EffortDialPanelProps) {
  return (
    <div className="flex w-72 flex-col p-1.5" data-effort-dial="true">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 rounded-sm px-1 py-1 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:text-foreground"
        onClick={() => props.onViewChange("dial")}
      >
        <ChevronLeftIcon className="size-3.5" />
        Select model
      </button>
      <PanelRow
        trailing={props.control === "levels" ? <CheckIcon className="size-4" /> : null}
        onClick={props.onChooseDefault}
      >
        <span className="flex min-w-0 flex-col">
          <span>Default</span>
          <span className="text-muted-foreground text-xs">Picks a model for each level</span>
        </span>
      </PanelRow>
      {props.models.map((model) => (
        <PanelRow
          key={model.key}
          trailing={model.selected ? <CheckIcon className="size-4" /> : null}
          onClick={() => props.onChooseModel(model.key)}
        >
          <ModelIdentity model={model} />
        </PanelRow>
      ))}
      <div className="mx-1 my-1 h-px bg-border" />
      <PanelRow
        trailing={<ChevronRightIcon className="size-3.5 opacity-60" />}
        onClick={props.onShowAllModels}
      >
        <span className="text-muted-foreground">All models</span>
      </PanelRow>
    </div>
  );
}

/** Effort slider under the model it applies to, or the list of models to choose from. */
export function EffortDialPanel(props: EffortDialPanelProps) {
  if (props.view === "models") return <ModelList {...props} />;

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
  const inset = { left: TRACK_RADIUS, right: TRACK_RADIUS } satisfies CSSProperties;

  return (
    <div className="flex w-72 flex-col p-1.5" data-effort-dial="true">
      <PanelRow
        trailing={
          <>
            {props.model.effortLabel}
            <ChevronRightIcon className="size-3.5 opacity-60" />
          </>
        }
        onClick={() => props.onViewChange("models")}
      >
        <ModelIdentity model={props.model} />
      </PanelRow>
      <div className="px-2 pt-2 pb-1">
        <div className="relative h-5" style={{ marginInline: TRACK_RADIUS }}>
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
                  // End labels line up with the track's ends rather than centring on the stop.
                  stopIndex === 0
                    ? "-translate-x-3.5"
                    : stopIndex === count - 1
                      ? "-translate-x-[calc(100%-0.875rem)]"
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
        <div className="relative mt-1.5 h-7 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn("absolute inset-0 rounded-full", motion)}
            style={{
              // Ends just past the thumb: at `fraction` of the travel plus one track radius.
              transform: `translateX(calc(${1 - fraction} * (2 * ${TRACK_RADIUS} - 100%)))`,
              background: `linear-gradient(90deg, ${FILL_COLORS[0]}, ${fillColor})`,
              opacity: index < 0 ? 0 : 1,
            }}
          />
          <div className="absolute inset-y-0" style={inset}>
            {props.stops.map((stop, stopIndex) => (
              <span
                key={stop.key}
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150 motion-reduce:transition-none",
                  stopIndex < index ? "bg-white/70" : "bg-foreground/30",
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
                  "absolute top-1/2 left-0 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.35)] transition-opacity duration-150 motion-reduce:transition-none",
                  index < 0 && "opacity-0",
                  selectedStop?.switchesModel &&
                    "outline-[1.5px] outline-muted-foreground outline-offset-2 outline-dashed",
                )}
              />
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(count - 1, 0)}
            step={1}
            value={Math.max(index, 0)}
            aria-label="Effort"
            aria-valuetext={selectedStop?.label ?? "Custom"}
            className="absolute inset-0 size-full cursor-pointer appearance-none bg-transparent opacity-0"
            onChange={(event) => selectStop(Number(event.currentTarget.value))}
            // With nothing selected the input already rests on the first stop,
            // so choosing it fires no change event.
            onClick={(event) => selectStop(Number(event.currentTarget.value))}
          />
        </div>
      </div>
      {props.note ? (
        <p className="px-2 pb-1 text-warning text-xs leading-snug">{props.note}</p>
      ) : null}
      {props.speed ? (
        <>
          <div className="mx-1 my-1 h-px bg-border" />
          <SpeedRow speed={props.speed} onChange={props.onSpeedChange} />
        </>
      ) : null}
    </div>
  );
}
