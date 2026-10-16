import { expect, it } from "@effect/vitest";
import { WebBuildUpdateUsageInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AnalyticsService from "./AnalyticsService.ts";
import * as WebBuildUpdateUsage from "./WebBuildUpdateUsage.ts";

const client = { surface: "web", clientOs: "Linux", clientAppVersion: "1.0.0" } as const;
const decodeUsage = Schema.decodeUnknownEffect(WebBuildUpdateUsageInput);
const decodeUsageSync = Schema.decodeUnknownSync(WebBuildUpdateUsageInput);

it.effect(
  "separates notice exposure from a requested refresh without collecting deployment data",
  () =>
    Effect.gen(function* () {
      const events: Array<unknown> = [];
      const service = yield* WebBuildUpdateUsage.WebBuildUpdateUsage.pipe(
        Effect.provide(WebBuildUpdateUsage.layer),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: (event, properties) =>
            Effect.sync(() => {
              events.push({ event, properties });
            }),
          flush: Effect.void,
        }),
      );
      const notice = yield* decodeUsage({
        action: "notice_shown",
        buildId: "synthetic-deployment",
        url: "https://example.test/private",
        content: "Synthetic draft",
      });
      yield* service.report(notice, client);
      yield* service.report({ action: "refresh_requested" }, client);
      const common = {
        feature: "web-build-update-notice",
        webBuildUpdateUsageVersion: 1,
        outcome: "success",
        durationMs: 0,
        ...client,
      };
      expect(events).toEqual([
        {
          event: "feature.exposed",
          properties: { ...common, action: "notice_shown", source: "system" },
        },
        {
          event: "feature.used",
          properties: { ...common, action: "refresh_requested", source: "user" },
        },
      ]);
    }),
);

it.effect(
  "does not attribute web refreshes to desktop, native mobile, or unidentified clients",
  () =>
    Effect.gen(function* () {
      const events: Array<unknown> = [];
      const service = yield* WebBuildUpdateUsage.WebBuildUpdateUsage.pipe(
        Effect.provide(WebBuildUpdateUsage.layer),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          flush: Effect.void,
        }),
      );
      yield* service.report({ action: "refresh_requested" }, { surface: "desktop" });
      yield* service.report({ action: "refresh_requested" }, { surface: "mobile" });
      yield* service.report({ action: "refresh_requested" }, {});
      expect(events).toEqual([]);
    }),
);

it.effect("analytics failure never fails the reporting RPC", () =>
  Effect.gen(function* () {
    const service = yield* WebBuildUpdateUsage.WebBuildUpdateUsage.pipe(
      Effect.provide(WebBuildUpdateUsage.layer),
      Effect.provideService(AnalyticsService.AnalyticsService, {
        record: () => Effect.die("Synthetic analytics failure"),
        flush: Effect.void,
      }),
    );
    yield* service.report({ action: "notice_shown" }, client);
    yield* service.report({ action: "refresh_requested" }, client);
  }),
);

it("rejects arbitrary analytics actions at the contract boundary", () => {
  expect(() => decodeUsageSync({ action: "arbitrary-event" })).toThrow();
});
