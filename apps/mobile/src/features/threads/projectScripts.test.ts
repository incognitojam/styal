import { ProjectReadFileError, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMobileProjectScripts } from "./projectScripts";

const localAction: ProjectScript = {
  id: "local",
  name: "Local",
  command: "vp local",
  icon: "play",
  runOnWorktreeCreate: true,
};

describe("resolveMobileProjectScripts", () => {
  it("uses local actions when styal.json is missing", () => {
    expect(
      resolveMobileProjectScripts({
        fileData: null,
        fileFailure: new ProjectReadFileError({
          cwd: "/repo",
          relativePath: "styal.json",
          failure: "not_found",
        }),
        localScripts: [localAction],
      }),
    ).toEqual([localAction]);
  });

  it("uses checkout actions when styal.json is valid", () => {
    expect(
      resolveMobileProjectScripts({
        fileData: {
          relativePath: "styal.json",
          contents: '{ "scripts": [{ "id": "file", "name": "File", "command": "vp file" }] }',
          byteLength: 80,
          truncated: false,
        },
        fileFailure: null,
        localScripts: [localAction],
      }),
    ).toEqual([
      {
        id: "file",
        name: "File",
        command: "vp file",
        icon: "play",
        runOnWorktreeCreate: false,
      },
    ]);
  });

  it("does not conceal an invalid styal.json with local actions", () => {
    expect(
      resolveMobileProjectScripts({
        fileData: {
          relativePath: "styal.json",
          contents: "{ not json",
          byteLength: 10,
          truncated: false,
        },
        fileFailure: null,
        localScripts: [localAction],
      }),
    ).toEqual([]);
  });
});
