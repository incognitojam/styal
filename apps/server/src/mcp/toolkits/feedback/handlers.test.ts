import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FeedbackService from "../../../feedback/FeedbackService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AnalyticsService from "../../../telemetry/AnalyticsService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { observeHandlers } from "./handlers.ts";

it.effect("records one event with the outcome and none of the report", () =>
  Effect.gen(function* () {
    const events: Array<{ event: string; properties: unknown }> = [];
    const observed = yield* observeHandlers({
      report_styal_issue: () => Effect.succeed({ status: "declined" as const }),
    }).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, {
        recordOwners: () => Effect.void,
        record: (event, properties) => Effect.sync(() => void events.push({ event, properties })),
        flush: Effect.void,
      }),
    );
    yield* observed.report_styal_issue(
      { title: "Synthetic title", body: "Synthetic body" },
      {} as never,
    );
    expect(events).toEqual([
      {
        event: "feature.used",
        properties: {
          feature: "feedback",
          action: "report",
          source: "agent",
          feedbackStatus: "declined",
          outcome: "success",
          durationMs: expect.any(Number),
        },
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(FeedbackService.FeedbackService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {} as never),
      ),
    ),
  ),
);
