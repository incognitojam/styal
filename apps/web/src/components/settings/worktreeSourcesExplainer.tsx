import { WORKTREE_SOURCE_RELEASE_DAYS } from "@t3tools/contracts";
import {
  CheckIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  SquareTerminalIcon,
  Undo2Icon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Scene } from "../explainer/explainerScene";
import type { FeatureExplainer } from "../explainer/featureExplainer.logic";

/*
 * A bar is a file: solid while on disk, an outline once only Git's copy is left; dark bars are
 * files Git has no copy of. Each row stacks three layers with the same geometry and only the
 * solid one fades, so a slide composites seven small layers. Wording follows the user guide.
 */

type Bar =
  | { readonly kind: "file"; readonly grow: number }
  | { readonly kind: "mine"; readonly width: number }
  | { readonly kind: "label"; readonly name: string; readonly note?: string };

const MINE: Record<
  number,
  { readonly at: number; readonly width: number; readonly name: string; readonly note?: string }
> = {
  // Top-level files stay although Git holds them; this row keeps its solid layer.
  0: { at: 90, width: 0, name: "README.md", note: "top level" },
  1: { at: 56, width: 30, name: ".env" },
  3: { at: 204, width: 46, name: "date.ts", note: "edited" },
  5: { at: 104, width: 38, name: "notes.md", note: "new" },
};
const TOP_LEVEL_ROW = 0;
const ROW_UNITS = 428;
const SIZES = [14, 14, 22, 22, 30, 38, 54];

// Deterministic, so every frame and every client draws the same map.
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROWS: readonly (readonly Bar[])[] = (() => {
  const next = seeded(11);
  return Array.from({ length: 7 }, (_, row) => {
    const mine = MINE[row];
    const bars: Bar[] = [];
    let x = 0;
    let placed = mine === undefined;
    while (ROW_UNITS - x >= 12) {
      if (!placed && mine && x >= mine.at) {
        if (mine.width > 0) bars.push({ kind: "mine", width: mine.width });
        bars.push({ kind: "label", name: mine.name, ...(mine.note ? { note: mine.note } : {}) });
        x += mine.width + 98;
        placed = true;
        continue;
      }
      const grow = Math.min(SIZES[Math.floor(next() * SIZES.length)]!, ROW_UNITS - x);
      bars.push({ kind: "file", grow });
      x += grow + 4;
    }
    return bars;
  });
})();

/** One layer of a row. Every layer lays out the same items, so they line up exactly. */
function Layer({
  bars,
  paint,
  className,
  delayMs,
}: {
  readonly bars: readonly Bar[];
  readonly paint: "outline" | "fill" | "mine";
  readonly className?: string;
  readonly delayMs?: number;
}) {
  return (
    <div
      className={cn("absolute inset-0 flex gap-1", className)}
      style={delayMs === undefined ? undefined : { transitionDelay: `${delayMs}ms` }}
    >
      {bars.map((bar, index) => {
        const key = `${paint}:${index}`;
        if (bar.kind === "label") {
          return (
            <span
              key={key}
              className={cn(
                "relative z-10 -my-1.5 inline-flex h-5 shrink-0 items-center gap-1 rounded-md border bg-card px-1.5 text-2xs whitespace-nowrap shadow-xs",
                paint !== "mine" && "invisible",
              )}
            >
              <span className="font-mono leading-none">{bar.name}</span>
              {bar.note ? <span className="leading-none">{bar.note}</span> : null}
            </span>
          );
        }
        if (bar.kind === "mine") {
          return (
            <i
              key={key}
              className={cn("h-2.5 shrink-0 rounded-sm", paint === "mine" && "bg-foreground")}
              style={{ width: bar.width }}
            />
          );
        }
        return (
          <i
            key={key}
            className={cn(
              "h-2.5 rounded-sm",
              paint === "outline" && "explainer-tile-outline",
              paint === "fill" && "explainer-tile",
            )}
            style={{ flexGrow: bar.grow, flexBasis: 0 }}
          />
        );
      })}
    </div>
  );
}

function FileMap({ onDisk }: { readonly onDisk: boolean }) {
  return (
    <div className="grid gap-2 px-3.5 pt-3.5 pb-3">
      {ROWS.map((bars, row) => (
        // oxlint-disable-next-line react/no-array-index-key -- the rows are a fixed list in a fixed order
        <div key={row} className="relative h-2.5">
          <Layer bars={bars} paint="outline" />
          <Layer
            bars={bars}
            paint="fill"
            delayMs={row * 50}
            className={cn(
              "transition-opacity duration-260 ease-out motion-reduce:transition-none",
              onDisk || row === TOP_LEVEL_ROW ? "opacity-100" : "opacity-0",
            )}
          />
          {bars.some((bar) => bar.kind !== "file") ? <Layer bars={bars} paint="mine" /> : null}
        </div>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <span className="inline-flex gap-3.5">
      <span className="inline-flex items-center gap-1.5">
        <i className="h-2 w-3.5 rounded-xs explainer-tile-outline" />
        <span className="max-sm:hidden">Removed: Git holds an exact copy</span>
        <span className="sm:hidden">Removed, in Git</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i className="h-2 w-3.5 rounded-xs bg-foreground" />
        No copy in Git, stays
      </span>
    </span>
  );
}

const DAYS = WORKTREE_SOURCE_RELEASE_DAYS;
const settledFor = (
  <>
    <CircleCheckIcon />
    Settled {DAYS} days ago
  </>
);

export const worktreeSourcesExplainer: FeatureExplainer = {
  feature: "worktree-source-checkout",
  title: "Free source files in settled worktrees",
  guideUrl:
    "https://github.com/incognitojam/styal/blob/main/docs/user/project-settings.md#free-source-files-in-settled-worktrees",
  slides: [
    {
      title: "Settled threads stop filling your disk",
      lines: [
        `When every thread using a worktree has been settled for ${DAYS} days, styal removes files from it that Git already holds an exact copy of.`,
        "Anything Git has no copy of stays where it is: changes since your last git add, new files you haven't added, and local files such as .env.",
      ],
      steps: 3,
      Scene: ({ step }) => (
        <Scene.Window
          icon={<GitBranchIcon />}
          title="fix-date-filter"
          meta={
            <Scene.Swap
              shown={step >= 1 ? 1 : 0}
              align="end"
              items={[
                <>
                  <CircleCheckIcon />
                  Settled
                </>,
                settledFor,
              ]}
            />
          }
          footer={
            <Scene.Swap
              shown={step >= 2 ? 1 : 0}
              items={["Files on disk", <Legend key="legend" />]}
            />
          }
        >
          <FileMap onDisk={step < 2} />
        </Scene.Window>
      ),
    },
    {
      title: "Everything is back before you need it",
      lines: [
        "Send a message, open a terminal, revert files to an earlier message or run a Git action, and styal first puts the files back exactly as they were.",
        "If it can't, it stops and tells you why. Nothing starts in a half-empty folder.",
      ],
      steps: 4,
      Scene: ({ step }) => (
        <>
          <Scene.Window
            icon={<GitBranchIcon />}
            title="fix-date-filter"
            meta={
              <Scene.Swap
                shown={step === 0 ? 0 : step < 3 ? 1 : 2}
                align="end"
                items={[
                  settledFor,
                  <>
                    <LoaderCircleIcon />
                    Putting files back
                  </>,
                  <span key="working" className="inline-flex items-center gap-1.5 text-foreground">
                    <span className="size-2 rounded-full bg-primary" />
                    Working
                  </span>,
                ]}
              />
            }
            footer={
              <Scene.Swap
                shown={step < 2 ? 0 : step < 3 ? 1 : 2}
                items={[
                  <Legend key="legend" />,
                  "",
                  <span
                    key="back"
                    className="inline-flex items-center gap-1.5 text-success-foreground"
                  >
                    <CheckIcon />
                    Back exactly as they were
                  </span>,
                ]}
              />
            }
          >
            <FileMap onDisk={step >= 2} />
          </Scene.Window>
          <div className="flex justify-center gap-1.5 max-sm:gap-1">
            <Scene.Chip icon={<MessageSquareIcon />} label="Message" pressed={step >= 1} />
            <Scene.Chip icon={<SquareTerminalIcon />} label="Terminal" />
            <Scene.Chip icon={<Undo2Icon />} label="Revert files" />
            <Scene.Chip icon={<GitCommitHorizontalIcon />} label="Git action" />
          </div>
        </>
      ),
    },
  ],
};
