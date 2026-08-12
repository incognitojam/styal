import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestImageComparison } from "./PullRequestImageDiff";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("PullRequestImageComparison", () => {
  it("shows both revisions side by side when they exist", () => {
    const markup = renderToStaticMarkup(
      <PullRequestImageComparison oldImage={PNG} newImage={PNG} />,
    );

    expect(markup).toContain("Deleted version");
    expect(markup).toContain("Added version");
  });

  it("shows a single panel for a newly added image", () => {
    const markup = renderToStaticMarkup(
      <PullRequestImageComparison oldImage={null} newImage={PNG} />,
    );

    expect(markup).toContain("Added version");
    expect(markup).not.toContain("Deleted version");
  });
});
