import { describe, expect, it } from "vite-plus/test";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501:9");
  });

  it("omits the workspace label when the surrounding UI already supplies project context", () => {
    const options = { includeWorkspaceLabel: false } as const;

    expect(
      formatWorkspaceRelativePath(
        "/Users/cameron/.t3/worktrees/t3code-d9980d37/apps/web/src/dictation/dictationSession.ts",
        "/Users/cameron/.t3/worktrees/t3code-d9980d37",
        options,
      ),
    ).toBe("apps/web/src/dictation/dictationSession.ts");
    expect(
      formatWorkspaceRelativePath(
        "t3code-d9980d37/apps/web/src/dictation/dictationSession.ts:42:3",
        "/Users/cameron/.t3/worktrees/t3code-d9980d37",
        options,
      ),
    ).toBe("apps/web/src/dictation/dictationSession.ts:42:3");
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/dictation/dictationSession.ts",
        "/Users/cameron/.t3/worktrees/t3code-d9980d37",
        options,
      ),
    ).toBe("apps/web/src/dictation/dictationSession.ts");
  });

  it("does not rewrite absolute paths outside the workspace", () => {
    expect(
      formatWorkspaceRelativePath("D:/other/repository/file.ts", "C:/workspace/t3code", {
        includeWorkspaceLabel: false,
      }),
    ).toBe("D:/other/repository/file.ts");
  });
});
