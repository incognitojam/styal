export type ImageBounds = { x: number; y: number; width: number; height: number };

export function imageIntersectsViewport(image: ImageBounds, clips: readonly ImageBounds[]) {
  let { x, y, width, height } = image;
  for (const clip of clips) {
    const right = Math.min(x + width, clip.x + clip.width);
    const bottom = Math.min(y + height, clip.y + clip.height);
    x = Math.max(x, clip.x);
    y = Math.max(y, clip.y);
    width = right - x;
    height = bottom - y;
  }
  return width > 0 && height > 0;
}
