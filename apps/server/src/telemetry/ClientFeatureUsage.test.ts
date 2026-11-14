import { expect, it } from "@effect/vitest";
import {
  FORK_CLIENT_USAGE_VERSION,
  ForkClientUsageInput,
  ReportForkClientUsageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as ClientFeatureUsage from "./ClientFeatureUsage.ts";
const decode = Schema.decodeUnknownEffect(ForkClientUsageInput);
const isUsage = Schema.is(ForkClientUsageInput);

it.effect("silently discards retired client usage from every client surface", () =>
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
      for (const [feature, action] of [
        ["integration-settings", "change_requested"],
        ["pull-request-deployments", "open_logs"],
        ["web-build-update-notice", "notice_shown"],
        ["combined-update-confirmation", "confirmed"],
        ["diff-file-review-order", "alphabetical_selected"],
        ["mentioned-time-chips", "details_opened"],
        ["setup-thread-settlement", "continued"],
        ["sidebar-project-filter", "thread_started"],
        ["sidebar-project-groups", "reordered"],
        ["next-unread-thread", "nothing_waiting"],
        ["desktop-update-notice", "release_notes_opened"],
        ["project-actions", "run"],
        ["pull-request-bypass-merge", "merge"],
        ["incoming-share-thread", "added"],
        ["shortcuts-overview", "opened"],
        ["work-together", "start"],
        ["provider-sign-in", "start"],
        ["completion-sounds", "viewed_completion_suppressed"],
        ["machine-access", "set"],
        ["machine-list", "add"],
        ["client-settings", "snapshot"],
        ["mobile-settings", "snapshot"],
      ] as const) {
        const legacy = {
          feature,
          action,
          sendShortcut: "enter",
          notificationsEnabled: true,
        };
        const input = yield* decodeReport(legacy);
        expect(input).toEqual({ feature, action });
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

it.effect("records stream quality summaries from each client surface as their own event", () =>
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
    for (const surface of ["mobile", "web", "desktop"] as const) {
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
