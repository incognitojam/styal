import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as DelegatedWakeUsage from "./DelegatedWakeUsage.ts";

type Handlers = Parameters<typeof DelegatedWakeUsage.observeHandlers>[0];

it.effect("records the wake each delegate_task call chooses, and nothing from the task", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const analytics = AnalyticsService.AnalyticsService.of({
      recordOwners: () => Effect.void,
      record: (event, properties) =>
        Effect.sync(() => {
          events.push({ event, properties });
        }),
      flush: Effect.void,
    });
    const handlers = yield* DelegatedWakeUsage.observeHandlers({
      delegate_task: () => Effect.succeed({ taskId: "task:synthetic" }),
    } as unknown as Handlers).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
    // The stub handler reads none of the services the real tool declares.
    const call = (input: Record<string, unknown>) =>
      handlers
        .delegate_task(
          { task: "Synthetic private prompt", ...input } as Parameters<
            Handlers["delegate_task"]
          >[0],
          {} as Parameters<Handlers["delegate_task"]>[1],
        )
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {} as never),
          Effect.provideService(OrchestratorMcpService.OrchestratorMcpService, {} as never),
          Effect.provideService(ThreadManagementService.ThreadManagementService, {} as never),
        );

    yield* call({ wake: "all", wakeAfterMs: 60_000 });
    yield* call({ wake: "each" });
    yield* call({});

    const usage = (properties: Record<string, unknown>) => ({
      event: "feature.used",
      properties: {
        feature: "delegated-wake",
        action: "delegate",
        source: "agent",
        ...properties,
        outcome: "success",
        durationMs: 0,
      },
    });
    expect(events).toEqual([
      usage({ wake: "all", wakeAfter: true }),
      usage({ wake: "each" }),
      usage({ wake: "each" }),
    ]);
  }),
);
