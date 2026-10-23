import { expect, it } from "@effect/vitest";
import { FORK_CLIENT_USAGE_VERSION, ForkClientUsageInput, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProjectFileActionApprovals from "../project/ProjectFileActionApprovals.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as ClientFeatureUsage from "./ClientFeatureUsage.ts";

const decode = Schema.decodeUnknownEffect(ForkClientUsageInput);
const isUsage = Schema.is(ForkClientUsageInput);

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
    ]) {
      yield* report(yield* decode({ ...input, content: "Synthetic content", path: "/private" }));
      expect(events.at(-1)).toEqual({ event, properties: { ...input, ...properties, source } });
    }
    expect(isUsage({ feature: "arbitrary", action: "anything" })).toBe(false);
    expect(isUsage({ feature: "mentioned-time-chips", action: "notice_shown" })).toBe(false);
    expect(isUsage({ feature: "setup-thread-settlement", action: "continued" })).toBe(false);
    expect(isUsage({ feature: "sidebar-project-filter", action: "filter_set" })).toBe(false);
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
    expect(events).toHaveLength(10);
    expect(events[9]).toEqual({
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
