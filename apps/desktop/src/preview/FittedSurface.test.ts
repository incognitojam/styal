import { describe, expect, it } from "@effect/vitest";

import { planSurfaceCapture, toSurfaceInput } from "./FittedSurface.ts";

// A 1280x800 page fitted into a 760x475 panel on a 2x display.
const surface = { width: 1520, height: 950 };
const viewport = { width: 1280, height: 800, pageX: 0, pageY: 400, devicePixelRatio: 2 };

describe("planSurfaceCapture", () => {
  it("renders the whole viewport once at the requested scale", () => {
    expect(
      planSurfaceCapture(surface, viewport, { x: 0, y: 400, width: 1280, height: 800, scale: 0.5 }),
    ).toEqual({
      crop: { x: 0, y: 0, width: 1520, height: 950 },
      size: { width: 1280, height: 800 },
    });
  });

  it("captures the viewport at device scale without a clip", () => {
    expect(planSurfaceCapture(surface, viewport, undefined)?.size).toEqual({
      width: 2560,
      height: 1600,
    });
  });

  it("maps a document clip into the surface and keeps only what is on screen", () => {
    expect(
      planSurfaceCapture(surface, viewport, { x: 640, y: 1000, width: 1000, height: 400 }),
    ).toEqual({
      crop: { x: 760, y: 712, width: 760, height: 238 },
      size: { width: 1280, height: 400 },
    });
  });

  it("refuses a clip that is entirely off screen", () => {
    expect(planSurfaceCapture(surface, viewport, { x: 0, y: 0, width: 100, height: 100 })).toBe(
      null,
    );
  });
});

describe("toSurfaceInput", () => {
  it("scales pointer points and leaves other commands alone", () => {
    expect(toSurfaceInput("Input.dispatchDragEvent", { type: "drop", x: 10, y: 20 }, 0.5)).toEqual({
      type: "drop",
      x: 5,
      y: 10,
    });
    const params = { x: 10, y: 20 };
    expect(toSurfaceInput("Page.navigate", params, 0.5)).toBe(params);
  });
});
