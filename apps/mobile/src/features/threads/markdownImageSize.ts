export const MARKDOWN_IMAGE_MAX_WIDTH = 480;
const MARKDOWN_IMAGE_MAX_HEIGHT = 480;

export interface MarkdownImageDisplaySize {
  readonly width: number;
  readonly height: number;
}

/** SVG percentages need a viewport; use the intrinsic viewBox in that case. */
export function resolveSvgImageSize(props: Readonly<Record<string, unknown>>) {
  const dimension = (value: unknown) => {
    if (typeof value === "number") return value;
    if (typeof value !== "string" || !/^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value)) return NaN;
    return Number.parseFloat(value);
  };
  const width = dimension(props.width);
  const height = dimension(props.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    return { width, height };
  const viewBox =
    typeof props.viewBox === "string"
      ? props.viewBox
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [];
  if (
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2]! <= 0 ||
    viewBox[3]! <= 0
  )
    return null;
  return { width: viewBox[2]!, height: viewBox[3]! };
}

export function resolveMarkdownImageDisplaySize(input: {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly availableWidth: number;
}): MarkdownImageDisplaySize | null {
  if (
    !Number.isFinite(input.sourceWidth) ||
    !Number.isFinite(input.sourceHeight) ||
    !Number.isFinite(input.availableWidth) ||
    input.sourceWidth <= 0 ||
    input.sourceHeight <= 0 ||
    input.availableWidth <= 0
  ) {
    return null;
  }

  const scale = Math.min(
    1,
    input.availableWidth / input.sourceWidth,
    MARKDOWN_IMAGE_MAX_WIDTH / input.sourceWidth,
    MARKDOWN_IMAGE_MAX_HEIGHT / input.sourceHeight,
  );

  return {
    width: input.sourceWidth * scale,
    height: input.sourceHeight * scale,
  };
}

/** Tall enough that a portrait phone screenshot stays recognisable beside a landscape one. */
export const MARKDOWN_IMAGE_ROW_MIN_HEIGHT = 180;

/**
 * A thumbnail line's tile height. With no landscape image it is the tallest image's fitted height.
 * Otherwise it is what the most landscape image needs at the tile width, raised to a floor that
 * keeps a phone screenshot recognisable, and never more than the tallest image needs.
 */
export function resolveMarkdownImageRowHeight(
  sizes: ReadonlyArray<{ readonly width: number; readonly height: number }>,
  tileWidth: number,
): number | null {
  const fitted = sizes.flatMap((size) => {
    const display = resolveMarkdownImageDisplaySize({
      sourceWidth: size.width,
      sourceHeight: size.height,
      availableWidth: tileWidth,
    });
    return display ? [{ ratio: size.height / size.width, height: display.height }] : [];
  });
  if (fitted.length === 0) return null;
  const tallest = Math.max(...fitted.map((image) => image.height));
  const landscape = fitted.filter((image) => image.ratio < 1);
  if (landscape.length === 0) return tallest;
  const widestRatio = Math.min(...landscape.map((image) => image.ratio));
  const widest = Math.max(
    ...landscape.filter((image) => image.ratio === widestRatio).map((image) => image.height),
  );
  return Math.min(Math.max(widest, MARKDOWN_IMAGE_ROW_MIN_HEIGHT), tallest);
}
