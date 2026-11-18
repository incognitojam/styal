import { ClientSettingsSchema } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { folderSidebarMovePatch } from "./folderSidebarMove";

const decodeStoredSettings = Schema.decodeSync(ClientSettingsSchema);

// What an older build stored: it writes every field, so defaults are stored too.
const olderBuildDefaults = {
  boringSidebarEnabled: false,
  sidebarThreadGrouping: "none",
  sidebarProjectSortOrder: "updated_at",
} as const;

describe("folderSidebarMovePatch", () => {
  it.each([
    {
      state: "nothing stored yet (fresh install)",
      stored: {},
      savedOrder: [],
      result: { folders: true, sortOrder: "updated_at" },
    },
    {
      // The flat list was the default, so a stored flat list may never have been chosen.
      state: "flat list, default never touched or chosen",
      stored: olderBuildDefaults,
      savedOrder: ["project-a"],
      result: { folders: true, sortOrder: "updated_at" },
    },
    {
      state: "grouped headers with a saved project order",
      stored: { ...olderBuildDefaults, sidebarThreadGrouping: "project" },
      savedOrder: ["project-b", "project-a"],
      result: { folders: true, sortOrder: "manual" },
    },
    {
      state: "grouped headers without a saved project order",
      stored: { ...olderBuildDefaults, sidebarThreadGrouping: "project" },
      savedOrder: [],
      result: { folders: true, sortOrder: "updated_at" },
    },
    {
      state: "grouped headers sorted by creation with a saved order",
      stored: {
        ...olderBuildDefaults,
        sidebarThreadGrouping: "project",
        sidebarProjectSortOrder: "created_at",
      },
      savedOrder: ["project-a"],
      result: { folders: true, sortOrder: "manual" },
    },
    {
      // Folders already replaced the headers, which followed the Project order setting.
      state: "folders already on, grouping also on, with a saved order",
      stored: {
        ...olderBuildDefaults,
        boringSidebarEnabled: true,
        sidebarThreadGrouping: "project",
      },
      savedOrder: ["project-a"],
      result: { folders: true, sortOrder: "updated_at" },
    },
  ] as const)("$state", ({ stored, savedOrder, result }) => {
    const settings = decodeStoredSettings(stored);
    const patch = folderSidebarMovePatch(settings, savedOrder);
    const moved = { ...settings, ...patch };

    expect(moved.boringSidebarEnabled).toBe(result.folders);
    expect(moved.sidebarProjectSortOrder).toBe(result.sortOrder);
    expect(moved.folderSidebarDefaultApplied).toBe(true);
    // Moved once: the next load keeps whatever the user picks.
    expect(folderSidebarMovePatch({ ...moved, boringSidebarEnabled: false }, savedOrder)).toBe(
      null,
    );
  });
});
