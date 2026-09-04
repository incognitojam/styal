import type { ProjectScript, T3ProjectFile } from "@t3tools/contracts";
import { parseStyalProjectFile } from "@t3tools/shared/styalProjectFile";
import { describe, expect, it } from "vite-plus/test";

import {
  legacyProjectScriptsForMigration,
  styalProjectFileContentsWithScripts,
} from "./styalProjectFileActions";

const dev: ProjectScript = {
  id: "dev",
  name: "Dev",
  command: "vp dev",
  icon: "play",
  runOnWorktreeCreate: false,
};

describe("styal project file actions", () => {
  it("preserves comments and unrelated fields when replacing actions", () => {
    const contents = styalProjectFileContentsWithScripts({
      currentContents: `{
  // Keep this project icon.
  "iconPath": "logo.svg",
  "scripts": [],
}\n`,
      legacyFile: null,
      scripts: [dev],
    });

    expect(contents).toContain("// Keep this project icon.");
    expect(parseStyalProjectFile(contents)).toMatchObject({
      iconPath: "logo.svg",
      scripts: [{ id: "dev", name: "Dev", command: "vp dev" }],
    });
  });

  it("creates styal.json with supported t3.json settings", () => {
    const legacyFile: T3ProjectFile = {
      $schema: "https://t3.codes/schema/t3.json",
      iconPath: "legacy.svg",
      defaultThreadEnvMode: "local",
      scripts: [{ name: "Test", command: "vp test", icon: "test" }],
    };
    const legacyScripts = legacyProjectScriptsForMigration({
      liveScripts: [],
      legacyFile,
      savedScripts: [],
    });
    const contents = styalProjectFileContentsWithScripts({
      currentContents: null,
      legacyFile,
      scripts: legacyScripts,
    });

    expect(parseStyalProjectFile(contents)).toEqual({
      $schema: "https://styal.build/schema/styal.json",
      iconPath: "legacy.svg",
      defaultThreadEnvMode: "local",
      scripts: [
        {
          id: "test",
          name: "Test",
          command: "vp test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ],
    });
  });

  it("deduplicates IDs while preserving distinct keybinding identities", () => {
    expect(
      legacyProjectScriptsForMigration({
        liveScripts: [dev],
        legacyFile: { scripts: [{ name: "Dev", command: "vp dev" }] },
        savedScripts: [
          { ...dev, id: "old-dev" },
          { ...dev, id: "lint", name: "Lint", command: "vp lint", icon: "lint" },
        ],
      }),
    ).toEqual([
      { ...dev, id: "old-dev" },
      { ...dev, id: "lint", name: "Lint", command: "vp lint", icon: "lint" },
    ]);
  });

  it("keeps the checkout's existing setup action when migrating another", () => {
    expect(
      legacyProjectScriptsForMigration({
        liveScripts: [{ ...dev, id: "setup", name: "Setup", runOnWorktreeCreate: true }],
        legacyFile: null,
        savedScripts: [{ ...dev, id: "old-setup", runOnWorktreeCreate: true }],
      }),
    ).toEqual([{ ...dev, id: "old-setup", runOnWorktreeCreate: false }]);
  });

  it("reserves saved IDs when assigning IDs to t3.json actions", () => {
    expect(
      legacyProjectScriptsForMigration({
        liveScripts: [],
        legacyFile: { scripts: [{ name: "Dev", command: "vp run new-dev" }] },
        savedScripts: [{ ...dev, command: "vp run saved-dev" }],
      }),
    ).toEqual([
      { ...dev, id: "dev-2", command: "vp run new-dev" },
      { ...dev, command: "vp run saved-dev" },
    ]);
  });
});
