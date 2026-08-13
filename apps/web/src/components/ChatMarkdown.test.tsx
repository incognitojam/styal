import type { Components } from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { orderedListGutterStyle } from "./ChatMarkdown";
import { createStableMarkdownComponents } from "./chatMarkdownRenderers";

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
  });
});

describe("createStableMarkdownComponents", () => {
  it("keeps renderer identities while delegating to the latest implementation", () => {
    let firstRenderCount = 0;
    let secondRenderCount = 0;
    const firstParagraph = () => {
      firstRenderCount += 1;
      return <p>first</p>;
    };
    const secondParagraph = () => {
      secondRenderCount += 1;
      return <p>second</p>;
    };
    let latest: Components = { p: firstParagraph };
    const stable = createStableMarkdownComponents(() => latest);
    const paragraphRenderer = stable.p;

    expect(typeof paragraphRenderer).toBe("function");
    if (typeof paragraphRenderer !== "function") return;
    const renderParagraph = paragraphRenderer as (props: object) => React.ReactNode;

    renderParagraph({ children: "message" });
    latest = { p: secondParagraph };

    expect(stable.p).toBe(paragraphRenderer);
    renderParagraph({ children: "updated message" });
    expect(firstRenderCount).toBe(1);
    expect(secondRenderCount).toBe(1);
  });
});
