import { describe, expect, it } from "vite-plus/test";

import {
  resolvePullRequestRepositoryImage,
  splitPullRequestBody,
} from "./pullRequestMarkdown.logic";

const GITHUB_CONTEXT = {
  provider: "github",
  repository: "incognitojam/timeline",
  url: "https://github.com/incognitojam/timeline/pull/753",
  headBranch: "add-self-contact-flag",
};

describe("pull request repository images", () => {
  it("resolves a GitHub blob image at the pull request branch", () => {
    expect(
      resolvePullRequestRepositoryImage(
        "https://github.com/incognitojam/timeline/blob/add-self-contact-flag/web/e2e/contact-detail.png?raw=1",
        GITHUB_CONTEXT,
      ),
    ).toEqual({ path: "web/e2e/contact-detail.png" });
  });

  it("resolves relative and commit-pinned repository images", () => {
    expect(resolvePullRequestRepositoryImage("./docs/screenshot.png", GITHUB_CONTEXT)).toEqual({
      path: "docs/screenshot.png",
    });
    expect(
      resolvePullRequestRepositoryImage(
        "https://github.com/incognitojam/timeline/blob/f4913679f3b33ba1848c6bf4934228e9eb71b30f/docs/screenshot.png",
        GITHUB_CONTEXT,
      ),
    ).toEqual({
      path: "docs/screenshot.png",
      revision: "f4913679f3b33ba1848c6bf4934228e9eb71b30f",
    });
  });

  it("resolves an image kept on a separate single-segment asset branch", () => {
    expect(
      resolvePullRequestRepositoryImage(
        "https://github.com/incognitojam/timeline/raw/assets/pr-858/sleep-card.png",
        GITHUB_CONTEXT,
      ),
    ).toEqual({
      path: "pr-858/sleep-card.png",
      revision: "assets",
      browserFallback: "https://github.com/incognitojam/timeline/raw/assets/pr-858/sleep-card.png",
    });
  });

  it("resolves raw-host and qualified-ref image URLs", () => {
    expect(
      resolvePullRequestRepositoryImage(
        "https://raw.githubusercontent.com/incognitojam/timeline/assets/pr-858/sleep-card.png",
        GITHUB_CONTEXT,
      ),
    ).toEqual({
      path: "pr-858/sleep-card.png",
      revision: "assets",
      browserFallback:
        "https://raw.githubusercontent.com/incognitojam/timeline/assets/pr-858/sleep-card.png",
    });
    expect(
      resolvePullRequestRepositoryImage(
        "https://raw.githubusercontent.com/incognitojam/timeline/refs/heads/assets/pr-858/sleep-card.png",
        GITHUB_CONTEXT,
      ),
    ).toEqual({
      path: "pr-858/sleep-card.png",
      revision: "refs/heads/assets",
      browserFallback:
        "https://raw.githubusercontent.com/incognitojam/timeline/refs/heads/assets/pr-858/sleep-card.png",
    });
  });

  it("keeps the authored URL when an unfamiliar ref and path split is only a guess", () => {
    const source = "https://github.com/incognitojam/timeline/raw/release/v1.2/docs/screenshot.png";
    expect(resolvePullRequestRepositoryImage(source, GITHUB_CONTEXT)).toEqual({
      path: "v1.2/docs/screenshot.png",
      revision: "release",
      browserFallback: source,
    });
  });

  it("leaves external, cross-repository, and unsafe paths alone", () => {
    expect(
      resolvePullRequestRepositoryImage("https://example.com/screenshot.png", GITHUB_CONTEXT),
    ).toBeNull();
    expect(
      resolvePullRequestRepositoryImage(
        "https://github.com/acme/other/blob/add-self-contact-flag/screenshot.png",
        GITHUB_CONTEXT,
      ),
    ).toBeNull();
    expect(resolvePullRequestRepositoryImage("../secret.png", GITHUB_CONTEXT)).toBeNull();
    expect(
      resolvePullRequestRepositoryImage(
        "https://raw.githubusercontent.com/incognitojam/timeline/assets/../../secret.png",
        GITHUB_CONTEXT,
      ),
    ).toBeNull();
    expect(
      resolvePullRequestRepositoryImage(
        "https://raw.githubusercontent.com/incognitojam/timeline/assets/%252e%252e/secret.png",
        GITHUB_CONTEXT,
      ),
    ).toBeNull();
  });
});

describe("pull request body segmentation", () => {
  it("keeps a plain body as a single markdown run", () => {
    expect(splitPullRequestBody("## What changed\n\nSome prose.")).toEqual([
      { id: "markdown:0", kind: "markdown", text: "## What changed\n\nSome prose." },
    ]);
  });

  // GitHub writes a dropped image into the body as an `<img>` tag, so a bare attachment link on
  // its own line is the shape it uses for a video — every one sampled in the wild was one.
  it("lifts a dropped video out and keeps the prose around it", () => {
    expect(
      splitPullRequestBody(
        "Before\n\nhttps://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456\n\nAfter",
      ),
    ).toEqual([
      { id: "markdown:0", kind: "markdown", text: "Before" },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456",
        media: "video",
      },
      { id: "markdown:2", kind: "markdown", text: "After" },
    ]);
  });

  it("names a bare link to a video file a video", () => {
    expect(splitPullRequestBody("https://example.com/demo.mp4?raw=1")).toEqual([
      {
        id: "attachment:0",
        kind: "attachment",
        url: "https://example.com/demo.mp4?raw=1",
        media: "video",
      },
    ]);
  });

  it("reads the source out of a video tag, including a multi-line one", () => {
    expect(
      splitPullRequestBody(
        '<video controls>\n  <source src="https://example.com/a.webm">\n</video>',
      ),
    ).toEqual([
      {
        id: "attachment:0",
        kind: "attachment",
        url: "https://example.com/a.webm",
        media: "video",
      },
    ]);
  });

  it("leaves a dropped image as markdown so it still renders as an image", () => {
    const body = "![shot](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-ab)";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves the img tag GitHub writes for a dropped image as markdown", () => {
    const body =
      '<img width="1414" alt="image" src="https://github.com/user-attachments/assets/7195f963-51a9-4331-be74-3e06be760422" />';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an ordinary link alone, whether it is bare or written as markdown", () => {
    const body = "https://example.com/page\n\n[the docs](https://example.com/docs)";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("never lifts a link inside fenced code out of it", () => {
    const body = "```\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("does not let a different fence marker close an open fence", () => {
    const body = "```\n~~~\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("keeps a video tag that shares its line with prose as markdown", () => {
    const body = 'Before <video src="https://example.com/a.mp4"></video> after';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("keeps the indentation that opens a code block", () => {
    const body = "    const answer = 42;";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("treats an info-string fence as a nested opener, not a close", () => {
    const body = "```\n```javascript\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an indented code line alone even when it is only a video link", () => {
    const body = "    https://example.com/demo.mp4";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an unclosed video tag as prose without eating the rest of the body", () => {
    const body = ['<video src="https://example.com/a.mp4">', "still prose", "more prose"].join(
      "\n",
    );
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("stays linear when the body is full of unclosed video tags", () => {
    const body = Array.from(
      { length: 4_000 },
      () => '<video src="https://example.com/a.mp4">',
    ).join("\n");
    const startedAt = performance.now();
    expect(splitPullRequestBody(body)).toHaveLength(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("refuses a non-http source rather than making a link out of it", () => {
    const body = '<video src="javascript:alert(1)"></video>';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });
});
