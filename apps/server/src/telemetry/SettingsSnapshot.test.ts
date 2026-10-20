import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as SettingsSnapshot from "./SettingsSnapshot.ts";

const defaultSnapshot = {
  defaultRuntimeMode: "full-access",
  defaultThreadEnvMode: null,
  defaultModelSelectionSet: false,
  responseStreamingMode: "paragraph",
  continueThreadsAfterServerUpdate: true,
  newWorktreesStartFromOrigin: true,
  worktreeSubmodules: null,
  worktreesDirectoryCustomized: false,
  defaultAutoPull: false,
  defaultProjectScriptCount: 0,
  projectsWithOverrides: 0,
  repositoriesWithApprovedFileActions: 0,
  sidebarAutoSettleOnMerge: true,
  sidebarAutoSettleAfterDays: 3,
  sidebarAutoSettleKeepPullRequests: false,
  snoozeLimitedThreads: false,
  autoResumeLimitedThreads: false,
  compactIdleThreads: false,
  branchNamingMode: "static",
  branchNamePrefixCustomized: false,
  textGenerationModelCustomized: false,
  sourceControlWriterModelSet: false,
  sourceControlWritingStyleMode: "repo_conventions",
  followChangeRequestTemplates: true,
  removeAgentCreditsOnMerge: false,
  pullRequestMergeMethod: null,
  reviewGuidesEnabled: false,
  reviewGuideModelSet: false,
  reviewGuideInstructionsCustomized: false,
  worktreeCleanupKeepWhen: "uncommitted-changes",
  worktreeCleanupAfterDays: null,
  worktreeCleanupOnMerge: false,
  worktreeCleanupOnDelete: false,
  worktreeCleanupUnchanged: false,
  browserArtifactsCleanupAfterDays: null,
  logsCleanupAfterDays: null,
  enableAgentBrowserAccess: true,
  enableAgentDeviceAccess: false,
  enableAgentHardwareAccess: false,
  enableDeviceSupport: false,
  deviceIdleShutdownMinutes: 10,
  keepPhysicalAndroidScreensOff: true,
  simulatorMemoryMode: "standard",
  projectsWithLowMemoryMode: 0,
  cursorKeychainUsageEnabled: false,
  backgroundActivityProfile: "balanced",
};

// Every free-text and record setting holds a marker that must never be reported.
const customizedSettings = {
  defaultRuntimeMode: "auto",
  defaultThreadEnvMode: "worktree",
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("synthetic_marker_instance"),
    model: "synthetic-marker-model",
  },
  worktreesDirectory: "/home/synthetic-marker/worktrees",
  defaultProjectScripts: [
    {
      id: "synthetic-marker-script",
      name: "synthetic marker script",
      command: "synthetic-marker --run",
      icon: "play",
      runOnWorktreeCreate: false,
    },
  ],
  projectSettingsOverrides: {
    [ProjectId.make("synthetic-marker-project")]: {
      branchNamePrefix: "synthetic-marker-prefix",
      defaultRuntimeMode: "approval-required",
      simulatorMemoryMode: "low-memory",
    },
    [ProjectId.make("synthetic-marker-empty")]: {},
  },
  projectFileActionApprovals: {
    "github.com/synthetic-marker/repo": {
      "synthetic-marker-action": {
        command: "synthetic-marker --setup",
        roles: ["setup"],
        approvedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  },
  sidebarAutoSettleAfterDays: null,
  branchNamingMode: "custom",
  branchNamePrefix: "synthetic-marker-branch",
  branchNameInstructions: "synthetic marker instructions",
  textGenerationModelSelection: {
    instanceId: ProviderInstanceId.make("synthetic_marker_writer"),
    model: "synthetic-marker-writer-model",
  },
  sourceControlWritingStyle: {
    mode: "custom",
    customInstructions: "synthetic marker style",
  },
  pullRequestMergeMethod: "squash",
  reviewGuidesEnabled: true,
  reviewGuideModelSelection: {
    instanceId: ProviderInstanceId.make("synthetic_marker_guide"),
    model: "synthetic-marker-guide-model",
  },
  reviewGuideInstructions: "synthetic marker guide instructions",
  storageCleanup: { worktreeAfterDays: 14, worktreeOnMerge: true, logsAfterDays: 30 },
  deviceIdleShutdownMinutes: null,
  keepPhysicalAndroidScreensOff: false,
  simulatorMemoryMode: "low-memory",
  usagePriceOverrides: {
    "synthetic-marker-priced-model": {
      inputCostPerMillionTokens: 1,
      outputCostPerMillionTokens: 2,
    },
  },
  addProjectBaseDirectory: "/home/synthetic-marker/projects",
} as const;

const recordingAnalytics = (events: Array<{ event: string; properties: unknown }>) =>
  Layer.succeed(
    AnalyticsService.AnalyticsService,
    AnalyticsService.AnalyticsService.of({
      record: (event, properties) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    }),
  );

it.effect("reports every allowlisted key after startup settles, then daily", () => {
  const events: Array<{ event: string; properties: unknown }> = [];
  return Effect.gen(function* () {
    yield* Layer.build(SettingsSnapshot.layer);
    yield* TestClock.adjust(Duration.minutes(1));
    assert.deepStrictEqual(events, []);

    yield* TestClock.adjust(Duration.minutes(1));
    assert.deepStrictEqual(events, [{ event: "settings.snapshot", properties: defaultSnapshot }]);

    yield* TestClock.adjust(Duration.hours(24));
    assert.strictEqual(events.length, 2);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(recordingAnalytics(events), ServerSettings.layerTest())),
  );
});

it.effect("reports changed values without names, paths, ids or record contents", () => {
  const events: Array<{ event: string; properties: unknown }> = [];
  return Effect.gen(function* () {
    yield* Layer.build(SettingsSnapshot.layer);
    yield* TestClock.adjust(Duration.minutes(2));

    assert.deepStrictEqual(events, [
      {
        event: "settings.snapshot",
        properties: {
          ...defaultSnapshot,
          defaultRuntimeMode: "auto",
          defaultThreadEnvMode: "worktree",
          defaultModelSelectionSet: true,
          worktreesDirectoryCustomized: true,
          defaultProjectScriptCount: 1,
          projectsWithOverrides: 1,
          repositoriesWithApprovedFileActions: 1,
          sidebarAutoSettleAfterDays: null,
          branchNamingMode: "custom",
          branchNamePrefixCustomized: true,
          textGenerationModelCustomized: true,
          sourceControlWritingStyleMode: "custom",
          pullRequestMergeMethod: "squash",
          reviewGuidesEnabled: true,
          reviewGuideModelSet: true,
          reviewGuideInstructionsCustomized: true,
          worktreeCleanupAfterDays: 14,
          worktreeCleanupOnMerge: true,
          logsCleanupAfterDays: 30,
          deviceIdleShutdownMinutes: null,
          keepPhysicalAndroidScreensOff: false,
          simulatorMemoryMode: "low-memory",
          projectsWithLowMemoryMode: 1,
        },
      },
    ]);
    assert.notInclude(JSON.stringify(events), "synthetic");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(recordingAnalytics(events), ServerSettings.layerTest(customizedSettings)),
    ),
  );
});

// Settings the snapshot deliberately leaves out. A new server setting must be
// reported or listed here, so the snapshot does not silently fall behind.
const NOT_REPORTED: Record<string, string> = {
  favorites: "per-user records",
  providerModelPreferences: "per-model records",
  previousWorktreesDirectories: "paths",
  enableProviderUpdateChecks: "in provider.inventory",
  autoUpdateProviders: "in provider.inventory",
  projectAgentBrowserAccessOverrides: "legacy view of projectSettingsOverrides",
  projectScriptOverrides: "legacy view of projectSettingsOverrides",
  projectAutoPullOverrides: "legacy view of projectSettingsOverrides",
  projectSettingsFolded: "migration marker",
  deviceOnboardingCompleted: "onboarding state",
  deviceHosts: "host addresses",
  environmentDeviceHosts: "host addresses",
  hardwareDevices: "device records",
  automaticGitFetchInterval: "legacy, read through backgroundActivity",
  providerHealthRefreshInterval: "legacy, read through backgroundActivity",
  backgroundActivityProfile: "legacy, read through backgroundActivity",
  defaultTheme: "free text",
  defaultThemeSetAt: "timestamp",
  environmentIcon: "user-chosen icon",
  addProjectBaseDirectory: "path",
  branchNameInstructions: "free text, implied by branchNamingMode",
  providerInstances: "provider.inventory",
  observability: "endpoints and credentials",
  sourceControlHosts: "host records",
  usageLimitSources: "account records",
  usagePriceOverrides: "per-model records",
  usageModelAliases: "per-model records",
};

it.effect("reads every server setting that is not deliberately left out", () => {
  const events: Array<{ event: string; properties: unknown }> = [];
  const readKeys = new Set<string>();
  const recordingSettings = Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      return ServerSettings.ServerSettingsService.of({
        ...service,
        getSettings: service.getSettings.pipe(
          Effect.map(
            (settings) =>
              new Proxy(settings, {
                get: (target, key, receiver) => {
                  if (typeof key === "string") readKeys.add(key);
                  return Reflect.get(target, key, receiver);
                },
              }),
          ),
        ),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest()));

  return Effect.gen(function* () {
    yield* Layer.build(SettingsSnapshot.layer);
    yield* TestClock.adjust(Duration.minutes(2));

    const unaccounted = Object.keys(DEFAULT_SERVER_SETTINGS).filter(
      (key) => !readKeys.has(key) && !(key in NOT_REPORTED),
    );
    assert.deepStrictEqual(unaccounted, []);
    const listedButRead = Object.keys(NOT_REPORTED).filter((key) => readKeys.has(key));
    assert.deepStrictEqual(listedButRead, []);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(recordingAnalytics(events), recordingSettings)),
  );
});
