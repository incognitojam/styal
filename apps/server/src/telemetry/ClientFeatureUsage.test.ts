import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PreviewManager from "../preview/Manager.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as ClientFeatureUsage from "./ClientFeatureUsage.ts";

it.effect(
  "counts explicit manual tab creation, excluding automation, legacy opens and status traffic",
  () =>
    Effect.gen(function* () {
      const events: Array<{ event: string; properties: unknown }> = [];
      const manager = yield* ClientFeatureUsage.preview({
        surface: "desktop",
        clientOs: "Linux",
        clientAppVersion: "1.0.0",
      }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: (event, properties) =>
            Effect.sync(() => {
              events.push({ event, properties });
            }),
          flush: Effect.void,
        }),
      );
      const threadId = ThreadId.make("feature-usage-thread");
      const manual = yield* manager.open({
        threadId,
        url: "https://example.test/private",
        usageSource: "user",
      });
      yield* manager.open({ threadId, url: "https://example.test/agent" });
      yield* manager.list({ threadId });
      yield* manager.reportStatus({
        threadId,
        tabId: manual.tabId,
        canGoBack: false,
        canGoForward: false,
        navStatus: {
          _tag: "Success",
          url: "https://example.test/private",
          title: "Synthetic page",
        },
      });
      const failure = yield* manager
        .open({ threadId, url: "javascript:invalid", usageSource: "user" })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("PreviewInvalidUrlError");
      expect((yield* manager.list({ threadId })).sessions).toHaveLength(2);
      expect(events).toEqual([
        {
          event: "feature.used",
          properties: {
            feature: "browser-sessions",
            action: "open",
            source: "user",
            outcome: "success",
            durationMs: 0,
            surface: "desktop",
            clientOs: "Linux",
            clientAppVersion: "1.0.0",
          },
        },
        {
          event: "feature.used",
          properties: {
            feature: "browser-sessions",
            action: "open",
            source: "user",
            outcome: "failure",
            durationMs: 0,
            surface: "desktop",
            clientOs: "Linux",
            clientAppVersion: "1.0.0",
          },
        },
      ]);
    }).pipe(Effect.provide(PreviewManager.layer)),
);
