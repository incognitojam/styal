import * as WorktreeCleanup from "../worktreeCleanup/WorktreeCleanup.ts";
import * as WorktreeCleanupApprovals from "../worktreeCleanup/Approvals.ts";
import {
  WorktreeCleanupError,
  type WorktreeCleanupReview,
  type WorktreeCleanupPreview,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import {
  FORK_CLIENT_USAGE_VERSION,
  ForkClientUsageInput,
  ReportForkClientUsageInput,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";

import * as FeedbackService from "../feedback/FeedbackService.ts";
import * as ProjectFileActionApprovals from "../project/ProjectFileActionApprovals.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as ClientFeatureUsage from "./ClientFeatureUsage.ts";

const decode = Schema.decodeUnknownEffect(ForkClientUsageInput);
const isUsage = Schema.is(ForkClientUsageInput);

it.effect("records viewed completion suppression without thread content", () =>
  Effect.gen(function* () {
    const events: unknown[] = [];
    for (const surface of ["web", "desktop", "mobile"] as const) {
      const report = yield* ClientFeatureUsage.reporter({ surface }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, {
          recordOwners: () => Effect.void,
          record: (event, properties) =>
            Effect.sync(() => {
              events.push({ event, properties });
            }),
          flush: Effect.void,
        }),
      );
      yield* report(
        yield* decode({
          feature: "completion-sounds",
          action: "viewed_completion_suppressed",
          threadId: "synthetic-thread",
          title: "Synthetic title",
        }),
      );
    }
    expect(events).toEqual(
      ["web", "desktop"].map((surface) => ({
        event: "feature.exposed",
        properties: {
          feature: "completion-sounds",
          action: "viewed_completion_suppressed",
          source: "system",
          surface,
          forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
        },
      })),
    );
  }),
);

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

it.effect("records one event per shortcuts overview open with its entry point", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const report = yield* ClientFeatureUsage.reporter({ surface: "web" }).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, {
        record: (event: string, properties: Record<string, unknown> | undefined) =>
          Effect.sync(() => {
            events.push({ event, properties });
          }),
        flush: Effect.void,
        recordOwners: () => Effect.void,
      }),
    );
    yield* report(
      yield* decode({ feature: "shortcuts-overview", action: "opened", entryPoint: "shortcut" }),
    );
    yield* report(yield* decode({ feature: "work-together", action: "start", outcome: "waiting" }));
    yield* report(
      yield* decode({ feature: "provider-sign-in", action: "start", entryPoint: "thread" }),
    );
    for (const action of ["add", "stop"] as const) {
      for (const outcome of ["success", "failure"] as const) {
        yield* report(
          yield* decode({
            feature: "machine-list",
            action,
            outcome,
            machineName: "Synthetic machine",
            url: "https://machine.example.test",
            pairingCode: "synthetic-code",
          }),
        );
      }
    }
    expect(events).toEqual([
      {
        event: "feature.used",
        properties: {
          feature: "shortcuts-overview",
          action: "opened",
          entryPoint: "shortcut",
          source: "user",
          forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
          surface: "web",
        },
      },
      {
        event: "feature.used",
        properties: {
          feature: "work-together",
          action: "start",
          outcome: "waiting",
          source: "user",
          forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
          surface: "web",
        },
      },
      {
        event: "feature.used",
        properties: {
          feature: "provider-sign-in",
          action: "start",
          entryPoint: "thread",
          source: "user",
          forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
          surface: "web",
        },
      },
      ...(["add", "stop"] as const).flatMap((action) =>
        (["success", "failure"] as const).map((outcome) => ({
          event: "feature.used",
          properties: {
            feature: "machine-list",
            action,
            outcome,
            source: "user",
            forkClientUsageVersion: FORK_CLIENT_USAGE_VERSION,
            surface: "web",
          },
        })),
      ),
    ]);
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

it.effect("silently discards legacy settings snapshots from every client surface", () =>
  Effect.gen(function* () {
    const events: unknown[] = [];
    const logs: unknown[] = [];
    const decodeReport = Schema.decodeUnknownEffect(ReportForkClientUsageInput);
    for (const surface of ["web", "desktop", "mobile"] as const) {
      const report = yield* ClientFeatureUsage.reporter({ surface }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, {
          recordOwners: () => Effect.void,
          record: (event, properties) =>
            Effect.sync(() => {
              events.push({ event, properties });
            }),
          flush: Effect.void,
        }),
      );
      for (const feature of ["client-settings", "mobile-settings"] as const) {
        const legacy = {
          feature,
          action: "snapshot",
          sendShortcut: "enter",
          notificationsEnabled: true,
        };
        const input = yield* decodeReport(legacy);
        expect(input).toEqual({ feature, action: "snapshot" });
        expect(isUsage(legacy)).toBe(false);
        yield* report(input).pipe(
          Effect.provide(
            Logger.layer(
              [
                Logger.make((entry) => {
                  logs.push(entry.message);
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        );
      }
    }
    expect(events).toEqual([]);
    expect(logs).toEqual([]);
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

it.effect(
  "observes feedback once with its outcome and none of the report, only from a surface",
  () =>
    Effect.gen(function* () {
      const events: unknown[] = [];
      const analytics = AnalyticsService.AnalyticsService.of({
        recordOwners: () => Effect.void,
        record: (event, properties) => Effect.sync(() => void events.push({ event, properties })),
        flush: Effect.void,
      });
      const service = FeedbackService.FeedbackService.of({
        submit: () =>
          Effect.succeed({
            status: "not_filed",
            reason: "Synthetic reason",
            manualUrl: "https://example.com/synthetic",
          }),
        reportFromAgent: () => Effect.die("unused"),
      });
      const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(AnalyticsService.AnalyticsService, analytics),
          Effect.provideService(FeedbackService.FeedbackService, service),
        );
      const draft = { title: "Synthetic title", body: "Synthetic body" };

      const relayed = yield* provided(ClientFeatureUsage.feedback({}));
      yield* relayed.submit(draft);
      expect(events).toEqual([]);

      const fromWeb = yield* provided(ClientFeatureUsage.feedback({ surface: "web" }));
      yield* fromWeb.submit(draft);
      expect(events).toEqual([
        {
          event: "feature.used",
          properties: {
            feature: "feedback",
            action: "submit",
            source: "user",
            feedbackStatus: "not_filed",
            surface: "web",
            outcome: "success",
            durationMs: expect.any(Number),
          },
        },
      ]);
    }),
);

it.effect(
  "observes cleanup preview, approval, revoke and forget without content or relay duplication",
  () =>
    Effect.gen(function* () {
      const events: Array<{ event: string; properties: Record<string, unknown> | undefined }> = [];
      const review: WorktreeCleanupReview & { notDeclared: string[] } = {
        notDeclared: [],
        status: "approved",
        declared: [{ pattern: "dist-private", status: "approved" }],
        approvedNotDeclared: [{ pattern: "cache-private", approvedAt: "2026-01-01T00:00:00.000Z" }],
      };
      let bytes: number | null = 1024;
      let failure = false;
      const preview = (): WorktreeCleanupPreview => ({
        review,
        patterns: ["dist-private"],
        worktreesTruncated: false,
        worktrees: [
          {
            worktreePath: "/synthetic/checkout",
            threadCount: 1,
            status: "eligible",
            selected: [
              {
                path: "private-output",
                pattern: "dist-private",
                patterns: ["dist-private"],
                patternStatus: "approved",
                kind: "directory",
                freedBytes: bytes,
              },
            ],
            kept: [],
            freedBytes: bytes,
            entriesTruncated: false,
            measurementComplete: bytes !== null,
          },
          {
            worktreePath: "/synthetic/empty",
            threadCount: 1,
            status: "eligible",
            selected: [],
            kept: [],
            freedBytes: 0,
            entriesTruncated: false,
            measurementComplete: bytes !== null,
          },
          {
            worktreePath: "/synthetic/held",
            threadCount: 1,
            status: "kept",
            reason: "unsettled-thread",
            selected: [],
            kept: [],
            freedBytes: 2048,
            entriesTruncated: false,
            measurementComplete: bytes !== null,
          },
        ],
      });
      const analytics = {
        record: (event: string, properties: Record<string, unknown> | undefined) =>
          Effect.sync(() => {
            events.push({ event, properties });
          }),
        flush: Effect.void,
      };
      const wrap = (surface?: "web") =>
        ClientFeatureUsage.worktreeCleanup(surface ? { surface } : {}).pipe(
          Effect.provideService(WorktreeCleanup.WorktreeCleanup, {
            preview: () =>
              failure
                ? Effect.fail(
                    new WorktreeCleanupError({
                      reason: "nothing-to-approve",
                      message: "private error content",
                    }),
                  )
                : Effect.succeed(preview()),
          }),
          Effect.provideService(WorktreeCleanupApprovals.Approvals, {
            review: () => Effect.succeed(review),
            approve: () => Effect.succeed(review),
            revoke: () => Effect.succeed(review),
          }),
          Effect.provideService(AnalyticsService.AnalyticsService, analytics),
        );
      const observed = yield* wrap("web");
      const projectId = ProjectId.make("private-project-id");
      yield* observed.cleanup.preview({ projectId, list: "approved" });
      yield* observed.approvals.approve({
        projectId,
        patterns: [" dist-private ", "dist-private", "absent-private"],
      });
      yield* observed.approvals.revoke({ projectId, pattern: "dist-private" });
      yield* observed.approvals.revoke({ projectId, pattern: null });
      yield* observed.approvals.revoke({ projectId, pattern: " cache-private " });
      expect(events).toEqual([
        {
          event: "feature.used",
          properties: {
            feature: "worktree-declared-cleanup",
            action: "preview",
            source: "user",
            surface: "web",
            outcome: "success",
            durationMs: 0,
            previewList: "approved",
            worktreeCount: 3,
            cleanableWorktreeCount: 1,
            freedBytes: 1024,
            truncated: false,
          },
        },
        {
          event: "feature.used",
          properties: {
            feature: "worktree-declared-cleanup",
            action: "approve",
            source: "user",
            surface: "web",
            outcome: "success",
            durationMs: 0,
            patternCount: 1,
          },
        },
        ...(["one", "all"] as const).map((revokeScope) => ({
          event: "feature.used",
          properties: {
            feature: "worktree-declared-cleanup",
            action: "revoke",
            source: "user",
            surface: "web",
            outcome: "success",
            durationMs: 0,
            revokeScope,
          },
        })),
        {
          event: "feature.used",
          properties: {
            feature: "worktree-declared-cleanup",
            action: "forget",
            source: "user",
            surface: "web",
            outcome: "success",
            durationMs: 0,
            revokeScope: "one",
          },
        },
      ]);
      bytes = null;
      yield* observed.cleanup.preview({ projectId, list: "declared" });
      expect(events.at(-1)?.properties).toMatchObject({
        freedBytes: null,
        previewList: "declared",
      });
      failure = true;
      yield* observed.cleanup.preview({ projectId, list: "approved" }).pipe(Effect.flip);
      expect(events.at(-1)?.properties).toEqual({
        feature: "worktree-declared-cleanup",
        action: "preview",
        source: "user",
        surface: "web",
        outcome: "failure",
        failureReason: "invalid_request",
        durationMs: 0,
      });
      failure = false;
      const relayed = yield* wrap();
      yield* relayed.cleanup.preview({ projectId, list: "approved" });
      yield* relayed.approvals.approve({ projectId, patterns: ["dist-private"] });
      yield* relayed.approvals.revoke({ projectId, pattern: null });
      expect(events).toHaveLength(7);
      expect(JSON.stringify(events)).not.toMatch(/private|synthetic/);
    }),
);
