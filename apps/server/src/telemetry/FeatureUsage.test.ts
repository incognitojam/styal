import { expect, it } from "@effect/vitest";
import {
  DeviceBootError,
  DeviceHeldError,
  DeviceHostUnavailableError,
  DeviceOperationError,
  DeviceHostId,
  DeviceId,
  HardwareToolError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2Command,
  ProjectFileActionApprovalError,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";
import { commandFeatureUsage, featureUsage } from "./FeatureUsage.ts";

const usage = { feature: "browser-tools", action: "snapshot", source: "agent" } as const;
const capture = (events: Array<unknown>) =>
  AnalyticsService.AnalyticsService.of({
    recordOwners: () => Effect.void,
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
        recordOwners: () => Effect.void,
        record: () => Effect.die("analytics unavailable"),
        flush: Effect.void,
      }),
    );
    expect(result).toBe("operation result");
  }),
);

it.effect.each([
  [
    "a boot that ran out of time",
    new DeviceBootError({
      hostId: DeviceHostId.make("local"),
      deviceId: DeviceId.make("simulator"),
      reason: "timeout",
      cause: null,
    }),
  ],
  [
    "a killed helper command",
    new DeviceOperationError({
      operation: "prepare",
      reason: "command_failed",
      exitCode: 124,
      cause: null,
    }),
  ],
  [
    "a device environment that stopped answering",
    new DeviceHostUnavailableError({
      hostId: DeviceHostId.make("peer"),
      reason: "No response.",
      cause: { timedOut: true },
    }),
  ],
] as const)("reports %s as a timeout", ([, failure]) =>
  Effect.gen(function* () {
    const events: Array<{ properties: Record<string, unknown> }> = [];
    yield* FeatureUsage.observe(
      { feature: "devices", action: "open", source: "agent" },
      Effect.fail(failure),
    ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, capture(events)), Effect.exit);
    expect(events[0]?.properties.failureReason).toBe("timeout");
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

const command = Schema.decodeUnknownSync(OrchestrationV2Command);
const ids = { commandId: "command-private", threadId: "thread-private" };

it("ignores messages, housekeeping commands, and untracked RPCs", () => {
  expect(
    commandFeatureUsage(
      command({
        ...ids,
        type: "message.dispatch",
        messageId: "message-private",
        text: "secret prompt",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      }),
    ),
  ).toBe(undefined);
  expect(
    commandFeatureUsage(
      command({ ...ids, type: "thread.visit", visitedAt: "2026-10-24T00:00:00.000Z" }),
    ),
  ).toBe(undefined);
  expect(featureUsage(WS_METHODS.terminalWrite, { data: "rm -rf" })).toBe(undefined);
});

it("leaves thread launches to client.thread.started", () => {
  expect(
    featureUsage(ORCHESTRATION_V2_WS_METHODS.launchThread, {
      title: "Private title",
      workspaceStrategy: { type: "worktree", baseRef: "main", branch: "secret-branch" },
    }),
  ).toBe(undefined);
});

it("tells watching a pull request apart from unwatching it", () => {
  const watch = (watching: boolean) =>
    commandFeatureUsage(
      command({
        ...ids,
        type: "thread.pull-request.watch",
        host: "github.com",
        repository: "owner/private",
        number: 7,
        watching,
      }),
    );
  expect(watch(true)).toEqual({ feature: "thread.pull_request.watch", variant: "on" });
  expect(watch(false)).toEqual({ feature: "thread.pull_request.watch", variant: "off" });
});

it("reads RPC variants from enums, never from paths or text", () => {
  expect(
    featureUsage(WS_METHODS.shellOpenInEditor, { cwd: "/Users/someone/secret", editor: "cursor" }),
  ).toEqual({ feature: "editor.open", variant: "cursor" });
  expect(featureUsage(WS_METHODS.terminalOpen, { cwd: "/Users/someone/secret" })).toEqual({
    feature: "terminal.open",
  });
});

it("leaves actions the fork reports under its own events to those events", () => {
  expect(featureUsage(WS_METHODS.deviceOpen, { platform: "ios", deviceId: "device-private" })).toBe(
    undefined,
  );
  expect(
    featureUsage(WS_METHODS.pullRequestsRunAction, { action: "approve-workflows", number: 7 }),
  ).toBe(undefined);
  expect(
    featureUsage(WS_METHODS.pullRequestsRunAction, { action: "update-branch", number: 7 }),
  ).toEqual({ feature: "pull_request.action", variant: "update-branch" });
  expect(commandFeatureUsage(command({ ...ids, type: "thread.settle" }))).toBe(undefined);
  expect(commandFeatureUsage(command({ ...ids, type: "thread.archive" }))).toBe(undefined);
  expect(
    commandFeatureUsage(
      command({ ...ids, type: "thread.snooze", snoozedUntil: "2026-10-25T00:00:00.000Z" }),
    ),
  ).toEqual({
    feature: "thread.snooze",
  });
});

it("counts stopping a thread as the same interrupt as stopping its run", () => {
  const interrupt = { feature: "run.interrupt" };
  expect(
    commandFeatureUsage(command({ ...ids, type: "run.interrupt", runId: "run-private" })),
  ).toEqual(interrupt);
  expect(commandFeatureUsage(command({ ...ids, type: "thread.stop" }))).toEqual(interrupt);
});
