import { expect, it } from "@effect/vitest";
import { FORK_CLIENT_USAGE_VERSION, ForkClientUsageInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
    ]) {
      yield* report(yield* decode({ ...input, content: "Synthetic content", path: "/private" }));
      expect(events.at(-1)).toEqual({ event, properties: { ...input, ...properties, source } });
    }
    expect(isUsage({ feature: "arbitrary", action: "anything" })).toBe(false);
    expect(isUsage({ feature: "mentioned-time-chips", action: "notice_shown" })).toBe(false);
    expect(isUsage({ feature: "setup-thread-settlement", action: "continued" })).toBe(false);
    expect(isUsage({ feature: "sidebar-project-filter", action: "filter_set" })).toBe(false);
    for (const surface of ["desktop", "mobile", undefined] as const) {
      const otherReport = yield* ClientFeatureUsage.reporter({ surface }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
      yield* otherReport({ feature: "web-build-update-notice", action: "refresh_requested" });
      yield* otherReport({ feature: "mentioned-time-chips", action: "details_opened" });
    }
    expect(events).toHaveLength(9);
    expect(events[8]).toEqual({
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
