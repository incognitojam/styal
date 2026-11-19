import { PROJECT_ICON_COLORS } from "./projectIconColors";
import type { ProjectIconColor } from "@t3tools/contracts";

export interface ProjectIdentity {
  readonly monogram: string;
  readonly color: ProjectIconColor;
}

function normalizeProjectName(projectName: string): string {
  return projectName.normalize("NFKC").trim();
}

function projectMonogram(projectName: string): string {
  const words = normalizeProjectName(projectName).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

function projectColor(projectName: string): ProjectIconColor {
  const seed = normalizeProjectName(projectName).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_COLORS.length;
  }
  return PROJECT_ICON_COLORS[index]?.value ?? "blue";
}

export function deriveProjectIdentity(projectName: string): ProjectIdentity {
  return {
    monogram: projectMonogram(projectName),
    color: projectColor(projectName),
  };
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The project tile in a 16-unit square: the sidebar's SVG and the bitmap a notification carries
 * both draw from these numbers. The text is stretched to `textWidth`.
 */
export const PROJECT_MONOGRAM_TILE = {
  size: 16,
  cornerRadius: 4,
  backgroundOpacity: 0.14,
  textX: 8,
  textBaseline: 10.8,
  fontSize: 8.25,
  fontWeight: 700,
  textWidth: (text: string) => (Array.from(monogramSegmenter.segment(text)).length === 1 ? 6 : 12),
} as const;
