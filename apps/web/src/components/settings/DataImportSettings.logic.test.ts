import { LegacyImportPreferences } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPreferenceComparisonRows,
  LEGACY_IMPORT_PREFERENCE_COUNT,
  LEGACY_IMPORT_PREFERENCE_KEYS,
  legacyImportPreviewsEqual,
  selectLegacyImportPreferences,
} from "./DataImportSettings.logic";

describe("data import preferences", () => {
  it("selects every allowlisted contract field", () => {
    const selected = selectLegacyImportPreferences(DEFAULT_SERVER_SETTINGS);

    expect(Object.keys(selected)).toEqual(LEGACY_IMPORT_PREFERENCE_KEYS);
    expect(LEGACY_IMPORT_PREFERENCE_KEYS).toEqual(Object.keys(LegacyImportPreferences.fields));
    expect(LEGACY_IMPORT_PREFERENCE_COUNT).toBe(11);
  });

  it("detects exact setting changes hidden by display rounding", () => {
    const base = selectLegacyImportPreferences(DEFAULT_SERVER_SETTINGS);
    const current = {
      ...base,
      automaticGitFetchInterval: Duration.millis(30_100),
    };
    const imported = {
      ...base,
      automaticGitFetchInterval: Duration.millis(30_200),
    };
    const comparison = buildPreferenceComparisonRows(imported, current);
    const gitFetch = comparison.find(({ row }) => row.id === "git-fetch");
    const policy = comparison.find(({ row }) => row.id === "background-activity");

    expect(gitFetch?.row.value).toBe(gitFetch?.current?.value);
    expect(gitFetch?.changed).toBe(true);
    expect(policy?.row.value).toBe(policy?.current?.value);
    expect(policy?.changed).toBe(true);
  });
});

describe("legacy import preview equality", () => {
  it("treats separately decoded equivalent previews as unchanged", () => {
    const first = {
      status: "available",
      sourceKind: "t3-code",
      schemaVersion: 4,
      projects: [
        {
          projectId: "project-1",
          title: "Example",
          workspaceRoot: "/workspace/example",
          faviconPath: null,
          threadCount: 2,
          scriptCount: 1,
          isExistingProject: false,
        },
      ],
    } as const;

    expect(legacyImportPreviewsEqual(first, structuredClone(first))).toBe(true);
    expect(
      legacyImportPreviewsEqual(first, {
        ...first,
        projects: [{ ...first.projects[0], threadCount: 3 }],
      }),
    ).toBe(false);
  });
});
