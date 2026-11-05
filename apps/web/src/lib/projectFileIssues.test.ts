import { parseStyalProjectFileResult } from "@t3tools/shared/projectFile";
import { describe, expect, it } from "vite-plus/test";

import { describeProjectFileIssues } from "./projectFileIssues";

describe("describeProjectFileIssues", () => {
  it("finds the file line of each issue, past comments and in multi-line entries", () => {
    const contents = `{
  // A comment line with "actions": [ in it.
  "scripts": [],
  /* A block comment
     over two lines. */
  "actions": [
    { "id": "dev", "name": "First", "command": "one" },
    { "id": "dev", "name": "Second", "command": "two" },
    {
      "name": "Third",
      "command": "three",
      "icon": "rocket",
    },
    {
      "name": "Fourth"
    },
  ],
}
`;
    const parsed = parseStyalProjectFileResult(contents);
    if (parsed.status === "invalid") throw new Error("expected a readable file");

    expect(
      describeProjectFileIssues(contents, parsed.issues).map((text) => text.split(":")[0]),
    ).toEqual(["Line 3", "Line 8", "Line 12", "Line 14"]);
  });

  it("keeps the message when the path is not in the file", () => {
    expect(describeProjectFileIssues("{}", [{ path: ["missing"], message: "Ignored" }])).toEqual([
      "Ignored",
    ]);
  });
});
