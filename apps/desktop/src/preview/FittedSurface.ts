/**
 * CDP for a fitted preview tab: one whose emulated viewport is scaled down into
 * a smaller <webview>. Chromium only has that on-screen surface's pixels, so a
 * CDP screenshot of the logical viewport tiles the surface instead of rendering
 * beyond it, and CDP mouse input lands on the scaled surface rather than at the
 * page coordinates locators report.
 */

const SURFACE_INPUT = new Set(["Input.dispatchMouseEvent", "Input.dispatchDragEvent"]);

/** Moves a CDP pointer command's page point onto the scaled surface. */
export const toSurfaceInput = (
  method: string,
  params: Record<string, unknown>,
  scale: number,
): Record<string, unknown> => {
  const { x, y } = params;
  if (!SURFACE_INPUT.has(method) || typeof x !== "number" || typeof y !== "number") return params;
  return { ...params, x: x * scale, y: y * scale };
};

export interface FittedViewport {
  /** CSS size of the viewport the surface displays. */
  readonly width: number;
  readonly height: number;
  /** Document offset of the viewport, the origin of `Page.captureScreenshot` clips. */
  readonly pageX: number;
  readonly pageY: number;
  readonly devicePixelRatio: number;
}

export interface ScreenshotClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale?: number;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where to crop the captured surface for a screenshot, and the size Chromium
 * would have rendered it at, so callers get the dimensions they asked for.
 * Null when the clip shows nothing on screen.
 */
export const planSurfaceCapture = (
  surface: { readonly width: number; readonly height: number },
  viewport: FittedViewport,
  clip: ScreenshotClip | undefined,
): { readonly crop: Rect; readonly size: { width: number; height: number } } | null => {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const left = Math.max(0, clip ? clip.x - viewport.pageX : 0);
  const top = Math.max(0, clip ? clip.y - viewport.pageY : 0);
  const right = Math.min(viewport.width, clip ? clip.x - viewport.pageX + clip.width : Infinity);
  const bottom = Math.min(viewport.height, clip ? clip.y - viewport.pageY + clip.height : Infinity);
  if (right <= left || bottom <= top) return null;
  const scaleX = surface.width / viewport.width;
  const scaleY = surface.height / viewport.height;
  const x = Math.floor(left * scaleX);
  const y = Math.floor(top * scaleY);
  const outputScale = (clip?.scale ?? 1) * viewport.devicePixelRatio;
  return {
    crop: {
      x,
      y,
      width: Math.max(1, Math.min(surface.width, Math.ceil(right * scaleX)) - x),
      height: Math.max(1, Math.min(surface.height, Math.ceil(bottom * scaleY)) - y),
    },
    size: {
      width: Math.max(1, Math.round((right - left) * outputScale)),
      height: Math.max(1, Math.round((bottom - top) * outputScale)),
    },
  };
};

const VIEWPORT_EXPRESSION = `({
  width: innerWidth,
  height: innerHeight,
  pageX: visualViewport ? visualViewport.pageLeft : scrollX,
  pageY: visualViewport ? visualViewport.pageTop : scrollY,
  devicePixelRatio,
})`;

const readClip = (value: unknown): ScreenshotClip | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y, width, height, scale } = value as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return undefined;
  }
  return { x, y, width, height, ...(typeof scale === "number" ? { scale } : {}) };
};

/** Answers `Page.captureScreenshot` from the surface the fitted tab actually displays. */
export const captureFittedScreenshot = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  params: Record<string, unknown>,
): Promise<{ readonly data: string }> => {
  const [image, reply] = await Promise.all([
    webContents.capturePage(),
    debuggee.sendCommand("Runtime.evaluate", {
      expression: VIEWPORT_EXPRESSION,
      returnByValue: true,
    }) as Promise<{ readonly result?: { readonly value?: FittedViewport } }>,
  ]);
  const viewport = reply.result?.value;
  const plan = viewport
    ? planSurfaceCapture(image.getSize(), viewport, readClip(params["clip"]))
    : null;
  if (!plan) throw new Error("The screenshot area is outside the preview's visible viewport.");
  const output = image.crop(plan.crop).resize({ ...plan.size, quality: "best" });
  const quality = typeof params["quality"] === "number" ? params["quality"] : 80;
  const encoded = params["format"] === "jpeg" ? output.toJPEG(quality) : output.toPNG();
  return { data: encoded.toString("base64") };
};
