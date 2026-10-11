import { describe, expect, it } from "vite-plus/test";

import { pullRequestRelativeImagePath } from "./pullRequestMarkdown.logic";

describe("pull request relative images", () => {
  it("reads a relative image as a repository path", () => {
    expect(pullRequestRelativeImagePath("./docs/screenshot.png", "github")).toBe(
      "docs/screenshot.png",
    );
    expect(pullRequestRelativeImagePath("docs/hello%20world.png?raw=1#frag", "github")).toBe(
      "docs/hello world.png",
    );
  });

  it("leaves qualified URLs to the default resolution", () => {
    for (const source of [
      "https://github.com/acme/web/blob/feature/docs/screenshot.png",
      "https://raw.githubusercontent.com/acme/web/assets/pr-7/screenshot.png",
      "https://github.com/user-attachments/assets/0f0e0d0c-1111-2222-3333-444455556666",
      "https://example.com/screenshot.png",
      "//example.com/screenshot.png",
      "/acme/web/raw/main/screenshot.png",
      "data:image/png;base64,AAAA",
    ]) {
      expect(pullRequestRelativeImagePath(source, "github")).toBeNull();
    }
  });

  it("rejects paths that leave the repository and other providers", () => {
    expect(pullRequestRelativeImagePath("../secret.png", "github")).toBeNull();
    expect(pullRequestRelativeImagePath("docs/%2e%2e/%2e%2e/secret.png", "github")).toBeNull();
    expect(pullRequestRelativeImagePath("docs\\screenshot.png", "github")).toBeNull();
    expect(pullRequestRelativeImagePath("docs/screenshot.png", "gitlab")).toBeNull();
  });
});
