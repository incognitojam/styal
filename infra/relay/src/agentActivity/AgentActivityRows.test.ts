import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";

const state: RelayAgentActivityState = {
  environmentId: "env-1" as RelayAgentActivityState["environmentId"],
  threadId: "thread-1" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deepLink: "/threads/env-1/thread-1",
};

describe("AgentActivityRows", () => {
  it.effect("returns the state an upsert replaced", () => {
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Effect.void,
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => Effect.succeed([{ stateJson: { ...state, phase: "waiting_for_input" } }]),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;
      expect(yield* rows.upsert({ environmentPublicKey: "public-key", state })).toEqual({
        ...state,
        phase: "waiting_for_input",
      });
    }).pipe(
      Effect.provide(
        AgentActivityRows.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db))),
      ),
    );
  });
});
