import { expect, it } from "@effect/vitest";
import { FORK_CLIENT_USAGE_VERSION, ForkClientUsageInput, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProjectFileActionApprovals from "../project/ProjectFileActionApprovals.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as ClientFeatureUsage from "./ClientFeatureUsage.ts";

const decode = Schema.decodeUnknownEffect(ForkClientUsageInput);
const isUsage = Schema.is(ForkClientUsageInput);

it.effect("records integration setting requests without environment names or setting values", () =>
  Effect.gen(function* () {
    const events: unknown[] = [];
    const report = yield* ClientFeatureUsage.reporter({ surface: "web" }).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, {
        recordOwners: () => Effect.void,
        record: (event, properties) =>
          Effect.sync(() => {
            events.push({ event, properties });
          }),
        flush: Effect.void,
      }),
    );
    for (const setting of [
      "browser_access",
      "device_support",
      "device_access",
      "device_idle_shutdown",
      "device_sharing",
    ] as const) {
      for (const settingScope of ["environment", "project"] as const) {
        const input = {
          feature: "integration-settings",
          action: "change_requested",
          setting,
          settingScope,
        } as const;
        yield* report(
          yield* decode({ ...input, environment: "Synthetic device host", value: true }),
        );
        expect(events.at(-1)).toEqual({
          event: "feature.used",
          properties: {
            ...input,
            source: "user",
            surface: "web",
            forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
          },
        });
      }
    }
    expect(events).toHaveLength(10);
    expect(
      isUsage({
        feature: "integration-settings",
        action: "change_requested",
        setting: "arbitrary",
        settingScope: "environment",
      }),
    ).toBe(false);
  }),
);

it.effect(
  "records deployment interactions with bounded outcomes and no PR or environment content",
  () =>
    Effect.gen(function* () {
      const events: unknown[] = [];
      const analytics = {
        record: (event: string, properties?: Record<string, unknown>) =>
          Effect.sync(() => {
            events.push({ event, properties });
          }),
        flush: Effect.void,
      };
      const client = { surface: "desktop" } as const;
      const report = yield* ClientFeatureUsage.reporter(client).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
      for (const action of ["open_environment", "open_logs", "show_all"] as const) {
        for (const outcome of ["success", "failure"] as const) {
          yield* report(
            yield* decode({
              feature: "pull-request-deployments",
              action,
              outcome,
              environment: "Synthetic preview",
              url: "https://preview.example.com",
              number: 7,
            }),
          );
          expect(events.at(-1)).toEqual({
            event: "feature.used",
            properties: {
              feature: "pull-request-deployments",
              action,
              outcome,
              source: "user",
              forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
              surface: "desktop",
            },
          });
        }
      }
      expect(events).toHaveLength(6);
      expect(
        isUsage({ feature: "pull-request-deployments", action: "arbitrary", outcome: "success" }),
      ).toBe(false);
    }),
);

it.effect("records allowlisted client interactions with socket attribution and no content", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const analytics = {
      record: (event: string, properties: Record<string, unknown> | undefined) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    };
    const client = { surface: "web", clientOs: "Linux", clientAppVersion: "1.0.0" } as const;
    const report = yield* ClientFeatureUsage.reporter(client).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
    const properties = { forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION, ...client };
    for (const { event, source, ...input } of [
      {
        feature: "web-build-update-notice",
        action: "notice_shown",
        event: "feature.exposed",
        source: "system",
      },
      {
        feature: "web-build-update-notice",
        action: "refresh_requested",
        event: "feature.used",
        source: "user",
      },
      {
        feature: "diff-file-review-order",
        action: "alphabetical_selected",
        view: "changes",
        event: "feature.used",
        source: "user",
      },
      {
        feature: "diff-file-review-order",
        action: "relevance_selected",
        view: "pull_request",
        event: "feature.used",
        source: "user",
      },
      {
        feature: "mentioned-time-chips",
        action: "details_opened",
        event: "feature.used",
        source: "user",
      },
      {
        feature: "setup-thread-settlement",
        action: "continued",
        settleOnMerge: false,
        settleWhenInactive: true,
        event: "feature.used",
        source: "user",
      },
      {
        feature: "sidebar-project-filter",
        action: "filter_set",
        entryPoint: "thread_menu",
        event: "feature.used",
        source: "user",
      },
      {
        feature: "sidebar-project-filter",
        action: "thread_started",
        event: "feature.used",
        source: "user",
      },
      {
        feature: "project-actions",
        action: "run",
        actionSource: "file",
        projectFile: "styal.json",
        event: "feature.used",
        source: "user",
      },
      {
        feature: "sidebar-project-groups",
        action: "pinned",
        entryPoint: "header_drag",
        event: "feature.used",
        source: "user",
      },
      {
        feature: "pull-request-bypass-merge",
        action: "merge",
        outcome: "success",
        event: "feature.used",
        source: "user",
      },
    ]) {
      yield* report(yield* decode({ ...input, content: "Synthetic content", path: "/private" }));
      expect(events.at(-1)).toEqual({ event, properties: { ...input, ...properties, source } });
    }
    expect(isUsage({ feature: "arbitrary", action: "anything" })).toBe(false);
    expect(isUsage({ feature: "mentioned-time-chips", action: "notice_shown" })).toBe(false);
    expect(isUsage({ feature: "setup-thread-settlement", action: "continued" })).toBe(false);
    expect(isUsage({ feature: "sidebar-project-filter", action: "filter_set" })).toBe(false);
    expect(isUsage({ feature: "sidebar-project-groups", action: "archived" })).toBe(false);
    expect(isUsage({ feature: "project-actions", action: "run", actionSource: "t3.json" })).toBe(
      false,
    );
    for (const surface of ["desktop", "mobile", undefined] as const) {
      const otherReport = yield* ClientFeatureUsage.reporter({ surface }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
      yield* otherReport({ feature: "web-build-update-notice", action: "refresh_requested" });
      yield* otherReport({ feature: "mentioned-time-chips", action: "details_opened" });
    }
    expect(events).toHaveLength(12);
    const mobile = yield* ClientFeatureUsage.reporter({ surface: "mobile" }).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
    yield* mobile({
      feature: "diff-file-review-order",
      action: "alphabetical_selected",
      view: "pull_request",
    });
    expect(events).toHaveLength(13);
    yield* mobile({ feature: "incoming-share-thread", action: "added", outcome: "success" });
    expect(events).toHaveLength(14);
    expect(events.at(-1)).toEqual({
      event: "feature.used",
      properties: {
        feature: "incoming-share-thread",
        action: "added",
        outcome: "success",
        source: "user",
        forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
        surface: "mobile",
      },
    });
    expect(events[12]).toEqual({
      event: "feature.used",
      properties: {
        feature: "diff-file-review-order",
        action: "alphabetical_selected",
        view: "pull_request",
        source: "user",
        forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
        surface: "mobile",
      },
    });
    expect(events[11]).toEqual({
      event: "feature.used",
      properties: {
        feature: "mentioned-time-chips",
        action: "details_opened",
        source: "user",
        forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
        surface: "desktop",
      },
    });
    const unavailable = yield* ClientFeatureUsage.reporter(client).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, {
        recordOwners: () => Effect.void,
        ...analytics,
        record: () => Effect.die("Synthetic collector failure"),
      }),
    );
    yield* unavailable({ feature: "mentioned-time-chips", action: "details_opened" });
  }),
);

it.effect("records the desktop update notice only from the desktop app", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const analytics = {
      record: (event: string, properties: Record<string, unknown> | undefined) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    };
    const desktop = { surface: "desktop", clientAppVersion: "1.2.0" } as const;
    const report = yield* ClientFeatureUsage.reporter(desktop).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
    for (const { event, source, action } of [
      { action: "notice_shown", event: "feature.exposed", source: "system" },
      { action: "release_notes_opened", event: "feature.used", source: "user" },
    ] as const) {
      yield* report(yield* decode({ feature: "desktop-update-notice", action, version: "1.2.0" }));
      expect(events.at(-1)).toEqual({
        event,
        properties: {
          feature: "desktop-update-notice",
          action,
          source,
          forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
          ...desktop,
        },
      });
    }
    expect(isUsage({ feature: "desktop-update-notice", action: "refresh_requested" })).toBe(false);
    const web = yield* ClientFeatureUsage.reporter({ surface: "web" }).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
    yield* web({ feature: "desktop-update-notice", action: "notice_shown" });
    expect(events).toHaveLength(2);
  }),
);

it.effect("separates combined update exposure from decisions without sending update content", () =>
  Effect.gen(function* () {
    const events: unknown[] = [];
    const analytics = {
      record: (event: string, properties?: Record<string, unknown>) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    };
    for (const surface of ["web", "desktop", "mobile", undefined] as const) {
      const report = yield* ClientFeatureUsage.reporter({ surface }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
      for (const action of ["shown", "confirmed", "cancelled"] as const) {
        const countBefore = events.length;
        yield* report(
          yield* decode({
            feature: "combined-update-confirmation",
            action,
            version: "1.2.0",
            host: "Synthetic computer",
            summary: "Synthetic update summary",
            threads: [{ title: "Synthetic thread" }],
          }),
        );
        if (surface === "web" || surface === "desktop") {
          expect(events).toHaveLength(countBefore + 1);
          expect(events.at(-1)).toEqual({
            event: action === "shown" ? "feature.exposed" : "feature.used",
            properties: {
              feature: "combined-update-confirmation",
              action,
              source: action === "shown" ? "system" : "user",
              forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
              surface,
            },
          });
        } else {
          expect(events).toHaveLength(countBefore);
        }
      }
    }
    expect(events).toHaveLength(6);
    for (const action of ["anything", "notice_shown", "install_succeeded"]) {
      expect(isUsage({ feature: "combined-update-confirmation", action })).toBe(false);
    }
  }),
);

it.effect(
  "observes approving and revoking styal.json actions once each, only from a user surface",
  () =>
    Effect.gen(function* () {
      const events: Array<{ event: string; properties: Record<string, unknown> | undefined }> = [];
      const analytics = {
        record: (event: string, properties: Record<string, unknown> | undefined) =>
          Effect.sync(() => {
            events.push({ event, properties });
          }),
        flush: Effect.void,
      };
      const review = {
        actionId: "setup",
        name: "Setup",
        command: "./scripts/setup.sh",
        roles: ["setup" as const],
        approved: null,
        hint: { kind: "none" as const },
      };
      const service = ProjectFileActionApprovals.ProjectFileActionApprovals.of({
        automationConfig: () => Effect.succeed(null),
        review: () => Effect.succeed(review),
        setApproved: () => Effect.succeed(review),
      });
      const wrap = (surface?: "web") =>
        ClientFeatureUsage.projectFileApprovals(surface ? { surface } : {}).pipe(
          Effect.provideService(ProjectFileActionApprovals.ProjectFileActionApprovals, service),
          Effect.provideService(AnalyticsService.AnalyticsService, analytics),
        );
      const input = { projectId: ProjectId.make("project-1"), actionId: "setup" };
      const observed = yield* wrap("web");
      yield* observed.setApproved({ ...input, approved: true });
      yield* observed.setApproved({ ...input, approved: false });
      const relayed = yield* wrap();
      yield* relayed.setApproved({ ...input, approved: true });
      expect(events.map((entry) => entry.properties?.action)).toEqual(["approve", "revoke"]);
      for (const entry of events) {
        expect(JSON.stringify(entry)).not.toContain("setup.sh");
        expect(JSON.stringify(entry)).not.toContain("project-1");
      }
    }),
);

it.effect("observes workflow approvals once each, only from a user surface", () =>
  Effect.gen(function* () {
    const events: Array<{ event: string; properties: Record<string, unknown> | undefined }> = [];
    const analytics = {
      record: (event: string, properties: Record<string, unknown> | undefined) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    };
    const wrap = (surface?: "desktop") =>
      ClientFeatureUsage.workflowApprovals(surface ? { surface } : {}).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
    const observed = yield* wrap("desktop");
    yield* observed(Effect.void);
    yield* Effect.flip(observed(Effect.fail("refused")));
    const relayed = yield* wrap();
    yield* relayed(Effect.void);
    expect(
      events.map((entry) => [
        entry.properties?.feature,
        entry.properties?.action,
        entry.properties?.source,
        entry.properties?.outcome,
      ]),
    ).toEqual([
      ["workflow-approvals", "approve", "user", "success"],
      ["workflow-approvals", "approve", "user", "failure"],
    ]);
  }),
);

it.effect("observes deployment reviews with their state only, from a user surface", () =>
  Effect.gen(function* () {
    const events: Array<Record<string, unknown> | undefined> = [];
    const analytics = {
      record: (_event: string, properties: Record<string, unknown> | undefined) =>
        Effect.sync(() => {
          events.push(properties);
        }),
      flush: Effect.void,
    };
    const wrap = (surface?: "web") =>
      ClientFeatureUsage.workflowRunReviews(surface ? { surface } : {}).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
    const observed = yield* wrap("web");
    yield* observed("approved", Effect.void);
    yield* Effect.flip(observed("rejected", Effect.fail("not watched")));
    const relayed = yield* wrap();
    yield* relayed("approved", Effect.void);
    expect(
      events.map((properties) => [
        properties?.feature,
        properties?.action,
        properties?.source,
        properties?.reviewState,
        properties?.outcome,
      ]),
    ).toEqual([
      ["workflow-run-watch", "review", "user", "approved", "success"],
      ["workflow-run-watch", "review", "user", "rejected", "failure"],
    ]);
  }),
);

const snapshot = {
  feature: "client-settings",
  action: "snapshot",
  sendShortcut: "mod-enter",
  followUpBehavior: "queue",
  composerRichTextEnabled: true,
  composerCollapseOnScroll: true,
  persistComposerContextStrip: false,
  proactivePanelsEnabled: true,
  showSkillsInSlashMenu: true,
  planModeEnabled: false,
  contextWindowMeterEnabled: false,
  turnUsageEnabled: true,
  turnUsageFigure: "tokens",
  chatWidth: "comfortable",
  wordWrap: true,
  mathRenderingEnabled: false,
  timestampFormat: "locale",
  loadBalancingEnabled: false,
  legacySidebarEnabled: false,
  sidebarWorkingShelfEnabled: true,
  sidebarThreadGrouping: "project",
  sidebarProjectGroupingMode: "repository",
  sidebarProjectGroupingOverrideCount: 2,
  sidebarProjectSortOrder: "manual",
  sidebarManualProjectOrderSaved: true,
  sidebarThreadSortOrder: "updated_at",
  sidebarThreadTimestampMode: "last_prompted",
  sidebarThreadPreviewCount: 6,
  confirmThreadArchive: false,
  confirmThreadDelete: true,
  confirmThreadUnpin: false,
  notificationMode: "sound",
  inAppNotificationsEnabled: false,
  completionSound: "t3-completion",
  inputSound: "t3-input",
  approvalSound: "t3-input",
  claudeStatusAlertsEnabled: true,
  openaiStatusAlertsEnabled: true,
  githubStatusAlertsEnabled: true,
  appearanceContrast: 100,
  glassOpacity: 80,
  panelAnimationDurationMs: 0,
  environmentIdentificationMode: "artwork",
  fontSizeInterface: 14,
  fontSizePrompt: 14,
  fontSizeCode: 13,
  fontSizeTerminal: 13,
  fontFamilySansCustomized: false,
  fontFamilyComposerCustomized: false,
  fontFamilyCodeCustomized: true,
  fontFamilyTerminalCustomized: false,
  fontSmoothing: true,
  diffColorScheme: "red-green",
  diffLayout: "stacked",
  diffFilesCollapsed: true,
  diffIgnoreWhitespace: true,
  browserLinkTarget: "system",
  pullRequestLinksOpenInApp: true,
  browserAutoShowFloatingPreview: true,
  browserDefaultViewport: "fill",
  browserDefaultZoomFactor: 1,
  browserDefaultAppearance: "system",
  browserSearchEngine: "google",
  browserCustomSearchUrlCustomized: false,
  browserProfileCount: 1,
  browserDefaultProfileCustomized: false,
  browserRecordingFrameRate: 30,
  browserRecordingShowKeyPresses: false,
  browserRecordingShowMousePresses: false,
  confirmQuit: "hold",
  discordRichPresence: false,
  snapShotEnabled: false,
  snapShotShortcutCustomized: false,
  snapShotIncludeAccessibility: true,
  snapShotPlaySound: true,
  snapShotSound: "soft-pop",
  snapShotFlash: true,
  snapShotAnimations: true,
} as const;

it.effect(
  "records a client settings snapshot as its own event without project or profile content",
  () =>
    Effect.gen(function* () {
      const events: Array<{ event: string; properties: Record<string, unknown> | undefined }> = [];
      const analytics = {
        record: (event: string, properties?: Record<string, unknown>) =>
          Effect.sync(() => {
            events.push({ event, properties });
          }),
        flush: Effect.void,
      };
      const report = yield* ClientFeatureUsage.reporter({ surface: "desktop" }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
      yield* report(
        yield* decode({
          ...snapshot,
          projectOrder: ["synthetic-project-key"],
          fontFamilyCode: "Synthetic Mono",
        }),
      );

      const { feature: _feature, action: _action, ...settings } = snapshot;
      expect(events).toEqual([
        {
          event: "client.settings.snapshot",
          properties: {
            ...settings,
            forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
            surface: "desktop",
          },
        },
      ]);
      expect(isUsage({ ...snapshot, sidebarThreadGrouping: "synthetic-project-key" })).toBe(false);
    }),
);

it.effect("records a snapshot from an older client with its missing settings absent", () =>
  Effect.gen(function* () {
    const events: Array<{ event: string; properties: Record<string, unknown> | undefined }> = [];
    const analytics = {
      record: (event: string, properties?: Record<string, unknown>) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    };
    const report = yield* ClientFeatureUsage.reporter({ surface: "web" }).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
    // Settings that later vocabulary versions added, missing from a client that predates them.
    const {
      mathRenderingEnabled: _mathRenderingEnabled,
      pullRequestLinksOpenInApp: _pullRequestLinksOpenInApp,
      browserSearchEngine: _browserSearchEngine,
      browserCustomSearchUrlCustomized: _browserCustomSearchUrlCustomized,
      ...olderSnapshot
    } = snapshot;
    yield* report(yield* decode(olderSnapshot));

    const { feature: _feature, action: _action, ...settings } = olderSnapshot;
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("client.settings.snapshot");
    expect(Object.keys(events[0]?.properties ?? {}).toSorted()).toEqual(
      [...Object.keys(settings), "forkClientUsageVersion", "surface"].toSorted(),
    );
    expect(events[0]?.properties).toMatchObject(settings);
    expect(isUsage({ ...olderSnapshot, chatWidth: "synthetic" })).toBe(false);
  }),
);

const mobileSnapshot = {
  feature: "mobile-settings",
  action: "snapshot",
  notificationsEnabled: true,
  liveActivitiesEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: false,
  notifyOnFailure: true,
  attendedAlertDelaySeconds: 0,
  composerEnterBehavior: "send",
  followUpBehavior: "steer",
  planModeEnabled: false,
  turnUsageEnabled: true,
  turnUsageFigure: "cost",
  confirmThreadUnpin: true,
  threadTimestampMode: "last_prompted",
  threadGrouping: "none",
  projectGroupingMode: "repository",
  workingShelfEnabled: false,
  threadListWorkingShelfExpanded: false,
  threadListSettledShelfExpanded: true,
  threadListSnoozedShelfExpanded: false,
  modelFavoriteCount: 2,
  microphoneOrderCustomized: false,
  themeMode: "system",
  lightThemeId: "t3-code",
  darkThemeId: "material-you",
  baseFontSize: 15,
  terminalFontSize: null,
  codeFontSize: 12,
  codeWordBreak: false,
  mathRenderingEnabled: false,
  diffSortMode: "relevance",
  pullRequestHideTestFiles: false,
  pullRequestMergeMethod: "squash",
} as const;

it.effect("records a mobile settings snapshot only from mobile, as the client settings event", () =>
  Effect.gen(function* () {
    const events: Array<{ event: string; properties: Record<string, unknown> | undefined }> = [];
    const analytics = {
      record: (event: string, properties?: Record<string, unknown>) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    };
    const reporter = (surface: "web" | "desktop" | "mobile") =>
      ClientFeatureUsage.reporter({ surface, clientOs: "iOS", clientAppVersion: "9.9.9" }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
    const input = yield* decode({ ...mobileSnapshot, connectOnboardingOptOutAccounts: ["x"] });
    yield* (yield* reporter("web"))(input);
    yield* (yield* reporter("desktop"))(input);
    yield* (yield* reporter("mobile"))(yield* decode(snapshot));
    expect(events).toEqual([]);

    yield* (yield* reporter("mobile"))(input);
    const { feature: _feature, action: _action, ...settings } = mobileSnapshot;
    expect(events).toEqual([
      {
        event: "client.settings.snapshot",
        properties: {
          ...settings,
          forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
          surface: "mobile",
          clientOs: "iOS",
          clientAppVersion: "9.9.9",
        },
      },
    ]);
    expect(isUsage({ ...mobileSnapshot, darkThemeId: "Synthetic Theme Name" })).toBe(false);
  }),
);

it.effect("records stream quality summaries from web and mobile as their own event", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const analytics = {
      record: (event: string, properties: Record<string, unknown> | undefined) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    };
    const summary = {
      feature: "device-stream-health",
      action: "session_ended",
      platform: "android",
      transport: "h264",
      connection: "network",
      durationSeconds: 95,
      averageFps: 41,
      decoderResets: 3,
      reconnects: 1,
      stalls: 2,
      longestGapMs: 1_800,
      maxAddedDelayMs: 4_200,
    } as const;
    for (const surface of ["mobile", "web"] as const) {
      const report = yield* ClientFeatureUsage.reporter({ surface }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
      yield* report(yield* decode({ ...summary, deviceId: "emulator-5554" }));
      const { feature: _feature, action: _action, ...measures } = summary;
      expect(events.at(-1)).toEqual({
        event: "device.stream.summary",
        properties: { ...measures, surface, forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION },
      });
    }
    expect(isUsage({ ...summary, decoderResets: -1 })).toBe(false);
  }),
);
