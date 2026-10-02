import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { deriveThreadCheckpointSummaries } from "./threadCheckpoints.ts";

describe("historical checkpoint review", () => {
  it("exposes frozen runless checkpoints without inventing native runs and associates the original answer", () => {
    const timestamp = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    const threadId = ThreadId.make("fixture-thread");
    const legacyTurnId = TurnId.make("original-turn");
    const answer = MessageId.make("original-answer");
    const historicalScope = CheckpointScopeId.make("import:v1:scope");
    const checkpoint = {
      id: CheckpointId.make("import:v1:checkpoint"),
      threadId,
      scopeId: historicalScope,
      runId: null,
      nodeId: NodeId.make("history-node"),
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      appRunOrdinal: null,
      legacyTurnId,
      legacyCheckpointTurnCount: 1,
      assistantMessageId: answer,
      ref: CheckpointRef.make("refs/t3/checkpoints/source-thread/turn/1"),
      status: "ready" as const,
      files: [{ path: "changed.ts", kind: "modified", additions: 3, deletions: 1 }],
      capturedAt: timestamp,
    };
    const nativeRun = RunId.make("native-run");
    const summaries = deriveThreadCheckpointSummaries({
      messages: [],
      checkpoints: [
        checkpoint,
        {
          ...checkpoint,
          id: CheckpointId.make("import:v1:zero-count"),
          legacyCheckpointTurnCount: 0,
        },
        {
          ...checkpoint,
          id: CheckpointId.make("native-checkpoint"),
          scopeId: CheckpointScopeId.make("native-scope"),
          runId: nativeRun,
          appRunOrdinal: 1,
          legacyTurnId: undefined,
          legacyCheckpointTurnCount: undefined,
          assistantMessageId: undefined,
        },
      ],
    });
    expect(summaries).toHaveLength(3);
    expect(summaries[0]).toMatchObject({
      checkpointId: checkpoint.id,
      scopeId: historicalScope,
      assistantMessageId: answer,
      checkpointTurnCount: 1,
      files: checkpoint.files,
      checkpointRef: checkpoint.ref,
    });
    expect(summaries[0]?.runId).not.toBe(nativeRun);
    expect(summaries[1]?.checkpointTurnCount).toBe(0);
    expect(summaries[2]?.runId).toBe(nativeRun);
    expect(summaries[0]?.runId).not.toBe(summaries[2]?.runId);
  });
});
