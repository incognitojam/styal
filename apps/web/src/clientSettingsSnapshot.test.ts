import { ClientSettingsSnapshot, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CLIENT_SETTINGS_SNAPSHOT_INTERVAL_MS,
  clientSettingsSnapshot,
  isClientSettingsSnapshotDue,
} from "./clientSettingsSnapshot";

const isSnapshot = Schema.is(ClientSettingsSnapshot);

const NOT_REPORTED: Record<string, string> = {
  loadBalancingWeights: "provider instance IDs",
  dismissedProviderUpdateNotificationKeys: "notice bookkeeping",
  onboardingCompletedAt: "timestamp, not a preference",
  favorites: "legacy, migrated to the environment",
  providerModelPreferences: "legacy, migrated to the environment",
  pullRequestMergeMethodOverrides: "per-repository records",
};

describe("clientSettingsSnapshot", () => {
  it("reports shipped defaults on a fresh device", () => {
    const snapshot = clientSettingsSnapshot(DEFAULT_CLIENT_SETTINGS, { projectOrder: [] });
    expect(isSnapshot(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      sendShortcut: "enter",
      followUpBehavior: "steer",
      sidebarThreadGrouping: "none",
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrideCount: 0,
      sidebarProjectSortOrder: "updated_at",
      sidebarManualProjectOrderSaved: false,
      sidebarThreadSortOrder: "updated_at",
      sidebarWorkingShelfEnabled: false,
      fontFamilyCodeCustomized: false,
      browserDefaultViewport: "fill",
      browserProfileCount: 0,
      browserDefaultProfileCustomized: false,
      snapShotShortcutCustomized: false,
    });
  });

  it("reports customized text, profiles and project order without their contents", () => {
    const snapshot = clientSettingsSnapshot(
      {
        ...DEFAULT_CLIENT_SETTINGS,
        sidebarThreadGrouping: "project",
        sidebarProjectSortOrder: "manual",
        sidebarProjectGroupingOverrides: { "synthetic-project-key": "separate" },
        fontFamilyCode: "Synthetic Mono",
        browserProfiles: [
          { id: "synthetic-profile", name: "Synthetic profile", kind: "persistent" },
        ],
        browserDefaultProfileId: "synthetic-profile",
        snapShotShortcut: { kind: "modifier-pair", modifier: "control" },
      },
      { projectOrder: ["synthetic-project-key", "another-project-key"] },
    );
    expect(snapshot).toMatchObject({
      sidebarThreadGrouping: "project",
      sidebarProjectSortOrder: "manual",
      sidebarProjectGroupingOverrideCount: 1,
      sidebarManualProjectOrderSaved: true,
      fontFamilyCodeCustomized: true,
      browserProfileCount: 1,
      browserDefaultProfileCustomized: true,
      snapShotShortcutCustomized: true,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic|another/i);
  });

  it("reads every client setting that is not deliberately left out", () => {
    const readKeys = new Set<string>();
    const settings = new Proxy(DEFAULT_CLIENT_SETTINGS, {
      get: (target, key, receiver) => {
        if (typeof key === "string") readKeys.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    clientSettingsSnapshot(settings, { projectOrder: [] });

    const unaccounted = Object.keys(DEFAULT_CLIENT_SETTINGS).filter(
      (key) => !readKeys.has(key) && !(key in NOT_REPORTED),
    );
    expect(unaccounted).toEqual([]);
    expect(Object.keys(NOT_REPORTED).filter((key) => readKeys.has(key))).toEqual([]);
  });
});

describe("isClientSettingsSnapshotDue", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");

  it("reports once a day after the last accepted report", () => {
    expect(isClientSettingsSnapshotDue(null, now)).toBe(true);
    expect(isClientSettingsSnapshotDue(new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(
      isClientSettingsSnapshotDue(
        new Date(now - CLIENT_SETTINGS_SNAPSHOT_INTERVAL_MS).toISOString(),
        now,
      ),
    ).toBe(true);
  });

  it("reports again after an unreadable or future timestamp instead of never", () => {
    expect(isClientSettingsSnapshotDue("not a date", now)).toBe(true);
    expect(isClientSettingsSnapshotDue(new Date(now + 60_000).toISOString(), now)).toBe(true);
  });
});
