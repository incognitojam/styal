import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectConfig,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

describe("settingInheritanceLayers", () => {
  it("shows the checkout's project file as a layer for file-backed keys", () => {
    const file = {
      source: "styal.json",
      actions: [],
      defaultThreadEnvMode: "worktree",
    } satisfies ProjectConfig;
    const fromFile = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file),
      },
      DEFAULT_SERVER_SETTINGS,
      "defaultThreadEnvMode",
    );
    expect(fromFile.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
      ["Project", "Inherits", false],
      ["Laptop", "Inherits", false],
      ["styal.json", "New worktree", true],
      ["Default", "New worktree", false],
    ]);
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" as const };
    const fromEnvironment = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(settings, projectId, null, file),
      },
      settings,
      "defaultThreadEnvMode",
    );
    expect(fromEnvironment.map((layer) => [layer.value, layer.effective])).toEqual([
      ["Inherits", false],
      ["Current checkout", true],
      ["Inherits", false],
      ["New worktree", false],
    ]);
  });

  it("names a legacy t3.json layer after the file in effect", () => {
    const layers = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {
          source: "t3.json",
          actions: [],
          defaultThreadEnvMode: "local",
        }),
      },
      DEFAULT_SERVER_SETTINGS,
      "defaultThreadEnvMode",
    );
    expect(layers.map((layer) => [layer.label, layer.effective])).toEqual([
      ["Project", false],
      ["Laptop", false],
      ["t3.json", true],
      ["Default", false],
    ]);
  });
});
