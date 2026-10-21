import { expect, it } from "@effect/vitest";
import {
  DeviceHeldError,
  DeviceHostId,
  DeviceId,
  HardwareToolError,
  ProjectFileActionApprovalError,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

const usage = { feature: "browser-tools", action: "snapshot", source: "agent" } as const;
const capture = (events: Array<unknown>) =>
  AnalyticsService.AnalyticsService.of({
    record: (event, properties) =>
      Effect.sync(() => {
        events.push({ event, properties });
      }),
    flush: Effect.void,
  });

it.effect("records completion once, with duration and no operation data", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const result = yield* FeatureUsage.observe(
      usage,
      TestClock.adjust(125).pipe(
        Effect.as({ url: "https://example.test/private", screenshot: "synthetic-page-bytes" }),
      ),
    ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, capture(events)));
    expect(result.url).toBe("https://example.test/private");
    expect(events).toEqual([
      { event: "feature.used", properties: { ...usage, outcome: "success", durationMs: 125 } },
    ]);
  }),
);

it.effect("preserves the original failure without collecting its message or arguments", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const failure = { _tag: "ExampleFailure", message: "synthetic private selector" };
    const exit = yield* FeatureUsage.observe(usage, Effect.fail(failure)).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, capture(events)),
      Effect.exit,
    );
    expect(exit).toEqual(Exit.fail(failure));
    expect(events).toEqual([
      { event: "feature.used", properties: { ...usage, outcome: "failure", durationMs: 0 } },
    ]);
  }),
);

it.effect("records cancellation while preserving interruption", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const started = yield* Deferred.make<void>();
    const fiber = yield* FeatureUsage.observe(
      usage,
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, capture(events)),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(events).toEqual([
      { event: "feature.used", properties: { ...usage, outcome: "cancelled", durationMs: 0 } },
    ]);
  }),
);

it.effect("analytics defects cannot turn a successful operation into a failure", () =>
  Effect.gen(function* () {
    const result = yield* FeatureUsage.observe(usage, Effect.succeed("operation result")).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, {
        record: () => Effect.die("analytics unavailable"),
        flush: Effect.void,
      }),
    );
    expect(result).toBe("operation result");
  }),
);

it.effect("reports a device another thread is using as in use, not as a failed operation", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const held = new DeviceHeldError({
      hostId: DeviceHostId.make("local"),
      deviceId: DeviceId.make("emulator-5554"),
      threadIds: [ThreadId.make("holder-thread")],
    });
    yield* FeatureUsage.observe(
      { feature: "devices", action: "open", source: "agent" },
      Effect.fail(held),
    ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, capture(events)), Effect.exit);
    expect(events).toEqual([
      {
        event: "feature.used",
        properties: {
          feature: "devices",
          action: "open",
          source: "agent",
          failureReason: "in_use",
          outcome: "failure",
          durationMs: 0,
        },
      },
    ]);
  }),
);

it.effect("records a hardware call's tier and a bounded refusal, never the device or action", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const usage = {
      feature: "hardware",
      action: "call",
      source: "agent",
      hardwareTier: "approve",
    } as const;
    yield* FeatureUsage.observe(
      usage,
      Effect.fail(
        new HardwareToolError({ code: "approval_declined", reason: 'The user declined "reboot".' }),
      ),
    ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, capture(events)), Effect.exit);
    yield* FeatureUsage.observe(
      { feature: "hardware", action: "acquire", source: "agent" },
      Effect.fail(new HardwareToolError({ code: "busy", reason: '"Calibrate" holds tree' })),
    ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, capture(events)), Effect.exit);
    expect(events).toEqual([
      {
        event: "feature.used",
        properties: { ...usage, failureReason: "declined", outcome: "failure", durationMs: 0 },
      },
      {
        event: "feature.used",
        properties: {
          feature: "hardware",
          action: "acquire",
          source: "agent",
          failureReason: "in_use",
          outcome: "failure",
          durationMs: 0,
        },
      },
    ]);
  }),
);

it.effect(
  "records styal.json approvals with bounded refusals and no project, action or command",
  () =>
    Effect.gen(function* () {
      const events: Array<unknown> = [];
      const observe = (
        action: "review" | "approve" | "revoke",
        effect: Effect.Effect<unknown, ProjectFileActionApprovalError>,
      ) =>
        FeatureUsage.observe(
          { feature: "project-file-approvals", action, source: "user" },
          effect,
          {
            surface: "web",
          },
        ).pipe(
          Effect.provideService(AnalyticsService.AnalyticsService, capture(events)),
          Effect.exit,
        );
      yield* observe("approve", Effect.succeed({ command: "./scripts/setup.sh" }));
      yield* observe(
        "review",
        Effect.fail(
          new ProjectFileActionApprovalError({
            reason: "action-not-found",
            message: "styal.json no longer has this action.",
          }),
        ),
      );
      yield* observe(
        "approve",
        Effect.fail(
          new ProjectFileActionApprovalError({
            reason: "nothing-to-approve",
            message: "This action does not run on its own.",
          }),
        ),
      );
      const base = {
        feature: "project-file-approvals",
        source: "user",
        surface: "web",
        durationMs: 0,
      };
      expect(events).toEqual([
        { event: "feature.used", properties: { ...base, action: "approve", outcome: "success" } },
        {
          event: "feature.used",
          properties: { ...base, action: "review", failureReason: "not_found", outcome: "failure" },
        },
        {
          event: "feature.used",
          properties: {
            ...base,
            action: "approve",
            failureReason: "invalid_request",
            outcome: "failure",
          },
        },
      ]);
    }),
);
