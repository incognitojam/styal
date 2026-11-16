import type { AssetImagePreview } from "@t3tools/contracts";

export function pullRequestImageWidth(
  width: number,
  pixelRatio: number,
): AssetImagePreview["width"] {
  const pixels = Math.ceil(Math.max(1, width) * Math.max(1, pixelRatio));
  return (
    ([320, 640, 960, 1440, 1920, 2880, 3840] as const).find((bucket) => bucket >= pixels) ?? 3840
  );
}
