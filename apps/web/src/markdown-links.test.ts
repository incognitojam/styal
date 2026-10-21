import { describe, expect, it } from "vite-plus/test";

import {
  buildMarkdownFileLinkParentSuffixes,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "./markdownFileHostPath";

describe("rewriteMarkdownFileUriHref", () => {
  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });

  it("preserves file uri authorities as windows UNC paths", () => {
    expect(rewriteMarkdownFileUriHref("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  // regression: #6433 workspace images in chat markdown did not render
  it("treats a localhost file uri as a local path", () => {
    expect(rewriteMarkdownFileUriHref("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });
});

describe("resolveMarkdownFileLinkMeta", () => {
  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "apps/web/src/session-logic.ts:501",
      workspaceRelativePath: "apps/web/src/session-logic.ts",
    });
  });

  it("resolves the encoded spaces emitted by the markdown renderer", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/Users/dara/Downloads/Lime%20Ride%20Artifacts/Bike%20Receipts",
        "/Users/dara/Downloads/Lime Ride Artifacts",
      ),
    ).toMatchObject({
      targetPath: "/Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts",
      workspaceRelativePath: "Bike Receipts",
      basename: "Bike Receipts",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
      workspaceRelativePath:
        "apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("disambiguates same-named files without exposing the active worktree directory", () => {
    const activePath =
      "/Users/cameron/.t3/worktrees/t3code-1fc35d1b/apps/web/src/dictation/dictationSession.ts";
    const illustrativePath =
      "/Users/cameron/.t3/worktrees/t3code-1fc35d1b/t3code-d9980d37/apps/web/src/dictation/dictationSession.ts";

    expect(
      Object.fromEntries(
        buildMarkdownFileLinkParentSuffixes([
          {
            filePath: activePath,
            workspaceRelativePath: "apps/web/src/dictation/dictationSession.ts",
          },
          {
            filePath: illustrativePath,
            workspaceRelativePath: "t3code-d9980d37/apps/web/src/dictation/dictationSession.ts",
          },
        ]),
      ),
    ).toEqual({
      [activePath]: "apps/web/src/dictation",
      [illustrativePath]: "t3code-d9980d37/apps/web/src/dictation",
    });
  });

  it("treats slash variants of the same Windows file as one path", () => {
    expect(
      buildMarkdownFileLinkParentSuffixes([
        {
          filePath: "C:/Users/example/project/src/main.ts",
          workspaceRelativePath: "src/main.ts",
        },
        {
          filePath: String.raw`C:\Users\example\project\src\main.ts`,
          workspaceRelativePath: "src/main.ts",
        },
      ]),
    ).toEqual(new Map());
  });

  it("does not create a preview path for files outside the workspace", () => {
    expect(resolveMarkdownFileLinkMeta("/tmp/report.ts", "/repo/project")).toMatchObject({
      workspaceRelativePath: null,
    });
  });

  it("does not classify a case-distinct POSIX sibling as a workspace file", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/tmp/t3code-case-test/project/probe.txt",
        "/tmp/t3code-case-test/Project",
      ),
    ).toMatchObject({
      displayPath: "/tmp/t3code-case-test/project/probe.txt",
      workspaceRelativePath: null,
    });
  });

  it("keeps Windows workspace comparisons case-insensitive", () => {
    expect(
      resolveMarkdownFileLinkMeta("C:/Users/MIKE/Project/src/main.ts", "c:/users/mike/project"),
    ).toMatchObject({
      displayPath: "src/main.ts",
      workspaceRelativePath: "src/main.ts",
    });
  });

  it("keeps drive-root workspace comparisons case-insensitive", () => {
    expect(resolveMarkdownFileLinkMeta("C:/Users/MIKE/project.ts", "c:/")).toMatchObject({
      displayPath: "Users/MIKE/project.ts",
      workspaceRelativePath: "Users/MIKE/project.ts",
    });
  });

  it("keeps backslash UNC workspace comparisons case-insensitive", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "\\\\server\\share\\PROJECT\\src\\main.ts",
        "\\\\Server\\Share\\Project",
      ),
    ).toMatchObject({
      displayPath: "src/main.ts",
      workspaceRelativePath: "src/main.ts",
    });
  });

  it.each([
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/file.ts", "c:/", "Users/MIKE/file.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts%20", "/tmp/repo", "file.ts "],
  ])("preserves the preview target for %s in workspace %s", (href, cwd, workspaceRelativePath) => {
    expect(resolveMarkdownFileLinkMeta(href, cwd)).toMatchObject({ workspaceRelativePath });
  });
});

describe("relative links inside a rendered host file", () => {
  it("anchor to the file's directory while workspace membership follows cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("appendix.md", "/repo", "/tmp/report");
    expect(meta).toMatchObject({
      filePath: "/tmp/report/appendix.md",
      workspaceRelativePath: null,
    });
    const inline = resolveInlineCodeFileLinkMeta("Makefile:12", "/repo", "/tmp/report");
    expect(inline).toMatchObject({ filePath: "/tmp/report/Makefile", line: 12 });
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/src/main.ts",
      workspaceRelativePath: "docs/src/main.ts",
    });
  });
});

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links bare filenames only when a line suffix marks them as file references", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.ts:10",
      line: 10,
    });
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", "/Users/julius/project")).toBeNull();
  });

  it("does not treat arbitrary name:digits shapes as files", () => {
    expect(resolveInlineCodeFileLinkMeta("error:1", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("TODO:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("exit:0", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("http:80", "/Users/julius/project")).toBeNull();
  });

  it("ignores hosts, ports, and versions", () => {
    expect(resolveInlineCodeFileLinkMeta("127.0.0.1:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("localhost:3000", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.com/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("10.0.0.1:80:1", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("localhost/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.uk/index.html", "/Users/julius/project"),
    ).toBeNull();
  });
});

describe("chat file chip paths", () => {
  const cwd = String.raw`C:\Users\alice\project`;

  it("opens and copies the indexed file for a bare filename, preserving its line and column", async () => {
    const meta = resolveMarkdownFileLinkMeta("user.ts:261:7", cwd);
    if (!meta) throw new Error("Expected a file link");
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd,
      findWorkspaceMatch: async () => "src/discord/events/user.ts",
    });

    expect(markdownFileEditorTarget(meta, hostPath)).toBe(
      String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
    );
    expect(markdownFileCopyPaths(meta, hostPath, cwd)).toEqual({
      fullPath: String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
      relativePath: "src/discord/events/user.ts:261:7",
    });
  });
});
