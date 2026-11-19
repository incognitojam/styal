import type { ProjectIconColor } from "@t3tools/contracts";
import { projectIconColorClassName } from "../projectIconColors";
import { PROJECT_MONOGRAM_TILE as TILE } from "../projectIdentity";
import { cn } from "~/lib/utils";

export function ProjectMonogram({
  text,
  color,
  className,
}: {
  readonly text: string;
  readonly color: ProjectIconColor;
  readonly className?: string | undefined;
}) {
  // Wrap the tile to avoid menu/button SVG margin trimming.
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox={`0 0 ${TILE.size} ${TILE.size}`}
        className={cn(
          "size-full overflow-hidden font-mono select-none",
          projectIconColorClassName(color),
        )}
        style={{
          borderRadius: `${(TILE.cornerRadius / TILE.size) * 100}%`,
          backgroundColor: `color-mix(in srgb, currentColor ${TILE.backgroundOpacity * 100}%, transparent)`,
        }}
      >
        <text
          x={TILE.textX}
          y={TILE.textBaseline}
          textAnchor="middle"
          fill="currentColor"
          className="font-mono"
          fontSize={TILE.fontSize}
          fontWeight={TILE.fontWeight}
          textLength={TILE.textWidth(text)}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
