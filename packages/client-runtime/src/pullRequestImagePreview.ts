import {
  ASSET_IMAGE_SOURCE_WIDTH_HEADER,
  ASSET_IMAGE_SOURCE_HEIGHT_HEADER,
  type AssetImageDimensions,
  type AssetImagePreview,
} from "@t3tools/contracts";

export function pullRequestImageWidth(
  width: number,
  pixelRatio: number,
): AssetImagePreview["width"] {
  const pixels = Math.ceil(Math.max(1, width) * Math.max(1, pixelRatio));
  return (
    ([320, 640, 960, 1440, 1920, 2880, 3840] as const).find((bucket) => bucket >= pixels) ?? 3840
  );
}

export async function fetchPullRequestPlaceholder(
  url: string,
  signal: AbortSignal,
  fetcher = globalThis.fetch,
): Promise<{ uri: string; sourceDimensions?: AssetImageDimensions }> {
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new Error("Image placeholder unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 65536) throw new Error("Image placeholder exceeds its byte limit");
  const width = Number(response.headers.get(ASSET_IMAGE_SOURCE_WIDTH_HEADER));
  const height = Number(response.headers.get(ASSET_IMAGE_SOURCE_HEIGHT_HEADER));
  const sourceDimensions =
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= 32_000_000
      ? { width, height }
      : undefined;
  return {
    uri: `data:${response.headers.get("content-type") ?? "image/webp"};base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`,
    ...(sourceDimensions ? { sourceDimensions } : {}),
  };
}
