/**
 * A fitted tab scales its emulated viewport into a smaller <webview>. Chromium only has that
 * surface's pixels, so CDP screenshots tile it and CDP mouse input lands on the scaled surface
 * rather than at the page coordinates locators report.
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

/**
 * The viewport the surface displays, in device-independent pixels: CSS pixels
 * times page zoom, the units of `Page.captureScreenshot` clips.
 */
export interface FittedViewport {
  readonly width: number;
  readonly height: number;
  /** Document offset of the viewport, the origin of clips. */
  readonly pageX: number;
  readonly pageY: number;
  /** Device pixels per device-independent pixel, without page zoom. */
  readonly displayRatio: number;
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
  const outputScale = (clip?.scale ?? 1) * viewport.displayRatio;
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

interface LayoutMetrics {
  readonly cssVisualViewport: { readonly pageX: number; readonly pageY: number; zoom?: number };
}

interface PageSize {
  readonly result?: {
    readonly value?: { readonly width: number; readonly height: number; readonly ratio: number };
  };
}

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
  const [image, metrics, size] = await Promise.all([
    webContents.capturePage(),
    debuggee.sendCommand("Page.getLayoutMetrics") as Promise<LayoutMetrics>,
    debuggee.sendCommand("Runtime.evaluate", {
      expression: "({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio })",
      returnByValue: true,
    }) as Promise<PageSize>,
  ]);
  const page = size.result?.value;
  // Measured as the server's snapshot measures a desktop page, which sizes its clip from this.
  const zoom = metrics.cssVisualViewport.zoom ?? 1;
  const plan = page
    ? planSurfaceCapture(
        image.getSize(),
        {
          width: page.width * zoom,
          height: page.height * zoom,
          pageX: metrics.cssVisualViewport.pageX * zoom,
          pageY: metrics.cssVisualViewport.pageY * zoom,
          displayRatio: page.ratio / zoom,
        },
        readClip(params["clip"]),
      )
    : null;
  if (!plan) throw new Error("The screenshot area is outside the preview's visible viewport.");
  const output = image.crop(plan.crop).resize({ ...plan.size, quality: "best" });
  const quality = typeof params["quality"] === "number" ? params["quality"] : 80;
  const encoded = params["format"] === "jpeg" ? output.toJPEG(quality) : output.toPNG();
  return { data: encoded.toString("base64") };
};
