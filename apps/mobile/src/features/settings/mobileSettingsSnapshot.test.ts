import { EnvironmentId, MobileSettingsSnapshot, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Preferences } from "../../persistence/mobile-preferences";
import { mobileSettingsSnapshot } from "./mobileSettingsSnapshot";

// The alert delay default lives beside the relay payload, which checks native push support.
vi.mock("../agent-awareness/capabilities", () => ({ supportsAgentAwarenessPush: () => true }));

const isSnapshot = Schema.is(MobileSettingsSnapshot);

const NOT_REPORTED: Record<string, string> = {
  connectOnboardingOptOutAccounts: "account identifiers",
  collapsedProjectGroups: "project keys",
  dismissedDatabaseStorageNotices: "notice bookkeeping",
  nativeUpdatePromptedTag: "update prompt bookkeeping",
  threadListFilters: "environment and project identifiers",
  pullRequestListFilters: "environment and project identifiers",
  updateRestartLocation: "navigation state, not a preference",
  workspaceSelections: "navigation state and thread identifiers, not a preference",
  markdownFontSize: "legacy, read only as baseFontSize",
  projectGroupingEnabled: "legacy, read only as projectGroupingMode",
  navigationTabOrder: "not settable while navigation customization is unavailable",
  hiddenNavigationTabs: "not settable while navigation customization is unavailable",
};

// Every preference set, so a new one fails to compile here until it is added.
const EVERY_PREFERENCE: Required<Preferences> = {
  pullRequestHideTestFiles: true,
  diffSortMode: "alphabetical",
  pullRequestMergeMethod: "rebase",
  liveActivitiesEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: false,
  notifyOnCompletion: false,
  notifyOnFailure: true,
  attendedAlertDelaySeconds: 120,
  themeId: "material-you",
  lightThemeId: "t3-code",
  darkThemeId: "material-you",
  themeMode: "dark",
  baseFontSize: 18,
  terminalFontSize: 12,
  markdownFontSize: 16,
  codeFontSize: null,
  codeWordBreak: true,
  mathRenderingEnabled: true,
  connectOnboardingOptOutAccounts: ["synthetic-account"],
  collapsedProjectGroups: ["synthetic-project-key"],
  dismissedDatabaseStorageNotices: ["synthetic-environment"],
  composerEnterBehavior: "newline",
  followUpBehavior: "queue",
  microphones: [
    { kind: "bluetooth", uid: "synthetic-uid", name: "Synthetic Headset" },
    { kind: "bluetooth" },
    { kind: "wired" },
  ],
  projectGroupingEnabled: false,
  projectGroupingMode: "repository_path",
  threadGrouping: "project",
  confirmThreadUnpin: false,
  threadTimestampMode: "last_message",
  planModeEnabled: true,
  turnUsageEnabled: false,
  turnUsageFigure: "cost",
  workingShelfEnabled: true,
  modelFavorites: [{ provider: ProviderInstanceId.make("codex"), model: "synthetic-model" }],
  threadListSettledShelfExpanded: true,
  threadListSnoozedShelfExpanded: true,
  nativeUpdatePromptedTag: "synthetic-tag",
  threadListWorkingShelfExpanded: true,
  threadListFilters: {
    environmentId: EnvironmentId.make("synthetic-environment"),
    projectKey: "synthetic-project-key",
  },
  pullRequestListFilters: { environmentId: "synthetic-environment", controls: {} },
  updateRestartLocation: { path: "/synthetic/path", fromUpdateId: null },
  workspaceSelections: {
    threads: { environmentId: "synthetic-environment", threadId: "synthetic-thread" },
    settings: "SettingsAppearance",
  },
  navigationTabOrder: ["usage", "threads", "pullRequests"],
  hiddenNavigationTabs: ["usage"],
};

describe("mobileSettingsSnapshot", () => {
  it("reports the app's defaults for a fresh install", () => {
    const snapshot = mobileSettingsSnapshot({}, { notificationsEnabled: false });
    expect(isSnapshot(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      notificationsEnabled: false,
      liveActivitiesEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
      attendedAlertDelaySeconds: 600,
      composerEnterBehavior: "send",
      followUpBehavior: "steer",
      planModeEnabled: false,
      turnUsageEnabled: true,
      turnUsageFigure: "tokens",
      threadGrouping: "none",
      projectGroupingMode: "repository",
      modelFavoriteCount: 0,
      microphoneOrderCustomized: false,
      themeMode: "system",
      lightThemeId: "t3-code",
      darkThemeId: "t3-code",
      terminalFontSize: null,
      codeFontSize: null,
      diffSortMode: "relevance",
      pullRequestMergeMethod: "squash",
    });
  });

  it("reports changed choices without names, accounts or project keys", () => {
    const snapshot = mobileSettingsSnapshot(EVERY_PREFERENCE, { notificationsEnabled: true });
    expect(isSnapshot(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      notificationsEnabled: true,
      liveActivitiesEnabled: false,
      notifyOnInput: false,
      attendedAlertDelaySeconds: 120,
      composerEnterBehavior: "newline",
      projectGroupingMode: "repository_path",
      modelFavoriteCount: 1,
      // A remembered headset alone is not a reordering; bluetooth above wired is.
      microphoneOrderCustomized: true,
      baseFontSize: 18,
      terminalFontSize: 12,
      pullRequestMergeMethod: "rebase",
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic/i);
  });

  it("does not count a remembered headset as a reordered microphone list", () => {
    const snapshot = mobileSettingsSnapshot(
      { microphones: [{ kind: "wired", uid: "synthetic-uid", name: "Synthetic Mic" }] },
      { notificationsEnabled: true },
    );
    expect(snapshot.microphoneOrderCustomized).toBe(false);
  });

  it("reads every preference that is not deliberately left out", () => {
    const readKeys = new Set<string>();
    const preferences = new Proxy(EVERY_PREFERENCE, {
      get: (target, key, receiver) => {
        if (typeof key === "string") readKeys.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    mobileSettingsSnapshot(preferences, { notificationsEnabled: true });

    const unaccounted = Object.keys(EVERY_PREFERENCE).filter(
      (key) => !readKeys.has(key) && !(key in NOT_REPORTED),
    );
    expect(unaccounted).toEqual([]);
    expect(Object.keys(NOT_REPORTED).filter((key) => readKeys.has(key))).toEqual([]);
  });
});
