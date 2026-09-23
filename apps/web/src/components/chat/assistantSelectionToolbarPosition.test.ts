import { describe, expect, it } from "vite-plus/test";
import { assistantSelectionToolbarPosition } from "./assistantSelectionToolbarPosition";

const toolbar = { width: 88, height: 32 };
const windowSize = { width: 800, height: 600 };

describe("assistant Cite button placement", () => {
  it("centers above the full selection, including wrapped text", () => {
    expect(
      assistantSelectionToolbarPosition({
        selection: { left: 100, top: 80, width: 500, bottom: 140 },
        toolbar,
        viewport: { top: 40, bottom: 500 },
        windowSize,
      }),
    ).toEqual({ left: 306, top: 40 });
  });

  it("stays above a selection at the bottom of the message area", () => {
    expect(
      assistantSelectionToolbarPosition({
        selection: { left: 100, top: 430, width: 200, bottom: 455 },
        toolbar,
        viewport: { top: 40, bottom: 480 },
        windowSize,
      }),
    ).toEqual({ left: 156, top: 390 });
  });

  it("keeps the button within a narrow window", () => {
    expect(
      assistantSelectionToolbarPosition({
        selection: { left: 780, top: 80, width: 20, bottom: 100 },
        toolbar,
        viewport: { top: 0, bottom: 600 },
        windowSize,
      }),
    ).toEqual({ left: 704, top: 40 });
  });

  it("uses the space below when the selection is near the top edge", () => {
    expect(
      assistantSelectionToolbarPosition({
        selection: { left: 100, top: 50, width: 200, bottom: 90 },
        toolbar,
        viewport: { top: 40, bottom: 500 },
        windowSize,
      }),
    ).toEqual({ left: 156, top: 98 });
  });
});
