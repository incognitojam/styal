import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
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
  continueThreadsAfterServerUpdate: false,
  newWorktreesStartFromOrigin: true,
  worktreeSubmodules: null,
  worktreesDirectoryCustomized: false,
  defaultAutoPull: false,
  defaultProjectScriptCount: 0,
  projectsWithOverrides: 0,
  sidebarAutoSettleOnMerge: true,
  sidebarAutoSettleAfterDays: 3,
  snoozeLimitedThreads: false,
  autoResumeLimitedThreads: false,
  branchNamingMode: "static",
  branchNamePrefixCustomized: false,
  textGenerationModelCustomized: false,
  sourceControlWriterModelSet: false,
  sourceControlWritingStyleMode: "repo_conventions",
  followChangeRequestTemplates: true,
  removeAgentCreditsOnMerge: false,
  pullRequestMergeMethod: null,
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
    },
    [ProjectId.make("synthetic-marker-empty")]: {},
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
  storageCleanup: { worktreeAfterDays: 14, worktreeOnMerge: true, logsAfterDays: 30 },
  deviceIdleShutdownMinutes: null,
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
          sidebarAutoSettleAfterDays: null,
          branchNamingMode: "custom",
          branchNamePrefixCustomized: true,
          textGenerationModelCustomized: true,
          sourceControlWritingStyleMode: "custom",
          pullRequestMergeMethod: "squash",
          worktreeCleanupAfterDays: 14,
          worktreeCleanupOnMerge: true,
          logsCleanupAfterDays: 30,
          deviceIdleShutdownMinutes: null,
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
