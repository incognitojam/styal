import {
  NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2ProviderTurnJson } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { upsertProviderTurn } from "./ProjectionStore.ts";

describe("provider turn token usage projection", () => {
  it("keeps live usage when a terminal update omits it", () => {
    const now = DateTime.makeUnsafe("2026-08-29T00:00:00.000Z");
    const running = {
      id: ProviderTurnId.make("provider-turn-usage"),
      providerThreadId: ProviderThreadId.make("provider-thread-usage"),
      nodeId: NodeId.make("node-usage"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
      tokenUsage: {
        usedTokens: 50_000,
        maxTokens: 200_000,
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    } satisfies OrchestrationV2ProviderTurn;
    const completed = {
      ...running,
      status: "completed",
      completedAt: now,
      tokenUsage: undefined,
    } satisfies OrchestrationV2ProviderTurn;

    const projected = upsertProviderTurn([running], completed);

    assert.deepEqual(projected[0]?.tokenUsage, running.tokenUsage);
    assert.equal(projected[0]?.status, "completed");
  });
});

it("keeps recorded cost and totals through a later update that omits finished usage", () => {
  const at = DateTime.makeUnsafe("2026-08-29T00:00:00.000Z");
  const previous = {
    id: ProviderTurnId.make("recorded-turn"),
    providerThreadId: ProviderThreadId.make("recorded-thread"),
    nodeId: NodeId.make("recorded-node"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "completed" as const,
    startedAt: at,
    completedAt: at,
    turnTokenUsage: {
      usageScope: "main_agent" as const,
      usageStatus: "complete" as const,
      hasSubagents: false,
      inputTokens: 123,
      outputTokens: 45,
      costUsd: 0.00123,
    },
    threadTokenUsage: {
      inputTokens: 123,
      outputTokens: 45,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      countedTurns: 1,
      turns: 1,
      partialTurns: 0,
      subagentTurns: 0,
      costUsd: 0.00123,
      pricedTurns: 1,
    },
  };
  const { turnTokenUsage: _usage, threadTokenUsage: _total, ...later } = previous;
  const stored = upsertProviderTurn([previous], later)[0]!;
  const encoded = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ProviderTurnJson))(stored);
  const decoded = Schema.decodeSync(Schema.fromJsonString(OrchestrationV2ProviderTurnJson))(
    encoded,
  );
  assert.equal(decoded.turnTokenUsage?.costUsd, 0.00123);
  assert.deepEqual(decoded.threadTokenUsage, previous.threadTokenUsage);
});
