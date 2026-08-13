import type { Components } from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { createStableMarkdownComponents } from "./chatMarkdownRenderers";

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
