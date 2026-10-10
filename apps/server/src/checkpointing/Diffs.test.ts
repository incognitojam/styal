import { describe, expect, it } from "vite-plus/test";

import { parseTurnDiffFilesFromNumstat, parseUnifiedDiffPaths } from "./Diffs.ts";

describe("parseTurnDiffFilesFromNumstat", () => {
  it("returns an empty list when no files changed", () => {
    expect(parseTurnDiffFilesFromNumstat("")).toEqual([]);
  });

  it("sorts files and preserves addition and deletion counts", () => {
    const numstat = ["0\t2\tsrc/b.ts", "2\t1\ta.txt", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 2 },
    ]);
  });

  it("uses destination paths for renames and copies", () => {
    const numstat = [
      "0\t0\t",
      "src/old.ts",
      "src/new.ts",
      "2\t1\t",
      "src/source.ts",
      "src/copied.ts",
      "1\t0\tother.ts",
      "",
    ].join("\0");

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "other.ts", additions: 1, deletions: 0 },
      { path: "src/copied.ts", additions: 2, deletions: 1 },
      { path: "src/new.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("keeps binary files and empty files with zero line changes", () => {
    const numstat = ["-\t-\timage.png", "0\t0\tempty.txt", ""].join("\0");
    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "empty.txt", additions: 0, deletions: 0 },
      { path: "image.png", additions: 0, deletions: 0 },
    ]);
  });

  it("preserves Unicode, tabs, line endings, and spaces in paths", () => {
    const path = " café\tline\r\nname.txt ";
    const numstat = `3\t2\t\0old\tname\n.txt\0${path}\0`;

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([{ path, additions: 3, deletions: 2 }]);
    expect(parseTurnDiffFilesFromNumstat(`1\t0\t${path}\0`)).toEqual([
      { path, additions: 1, deletions: 0 },
    ]);
  });
});

describe("parseUnifiedDiffPaths", () => {
  it("returns empty list for empty diff", () => {
    expect(parseUnifiedDiffPaths("")).toEqual([]);
  });

  it("reads paths from file headers, not from hunk lines that look like headers", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      "--- b/not-a-file.txt",
      "+++ b/also-not-a-file.txt",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,2 +3,0 @@",
      "-old",
      "",
    ].join("\r\n");

    expect(parseUnifiedDiffPaths(diff)).toEqual(["a.txt", "src/b.ts"]);
  });

  // Header lines as `git diff -M --src-prefix=a/ --dst-prefix=b/` writes them.
  const headers = (quotePath: boolean) =>
    [
      "diff --git a/bin.dat b/bin.dat",
      "Binary files a/bin.dat and b/bin.dat differ",
      ...(quotePath
        ? [
            String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`,
            String.raw`--- "a/caf\303\251.txt"`,
            String.raw`+++ "b/caf\303\251.txt"`,
          ]
        : ["diff --git a/café.txt b/café.txt", "--- a/café.txt", "+++ b/café.txt"]),
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      ...(quotePath
        ? [
            String.raw`diff --git a/old.ts "b/new dir/new \303\251.ts"`,
            "rename from old.ts",
            String.raw`rename to "new dir/new \303\251.ts"`,
          ]
        : [
            "diff --git a/old.ts b/new dir/new é.ts",
            "rename from old.ts",
            "rename to new dir/new é.ts",
          ]),
      String.raw`diff --git "a/quo\"te.txt" "b/quo\"te.txt"`,
      String.raw`--- "a/quo\"te.txt"`,
      String.raw`+++ "b/quo\"te.txt"`,
      String.raw`diff --git "a/tab\tname.txt" "b/tab\tname.txt"`,
      String.raw`--- "a/tab\tname.txt"`,
      String.raw`+++ "b/tab\tname.txt"`,
      "diff --git a/with space.txt b/with space.txt",
      "--- a/with space.txt\t",
      "+++ b/with space.txt\t",
      "",
    ].join("\n");

  it.each([false, true])(
    "handles binary, empty, deleted, renamed and unusual paths (quotePath %s)",
    (quotePath) => {
      expect(parseUnifiedDiffPaths(headers(quotePath))).toEqual(
        [
          "bin.dat",
          "café.txt",
          "empty.txt",
          "gone.txt",
          "new dir/new é.ts",
          'quo"te.txt',
          "tab\tname.txt",
          "with space.txt",
        ].toSorted((left, right) => left.localeCompare(right)),
      );
    },
  );
});
