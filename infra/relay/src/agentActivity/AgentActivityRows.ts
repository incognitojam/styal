import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AgentActivityPersistence } from "../persistence/EnvironmentPersistence.ts";

export class AgentActivityRowUpsertPersistenceError extends Schema.TaggedError<AgentActivityRowUpsertPersistenceError>()(
  "AgentActivityRowUpsertPersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowDeletePersistenceError extends Schema.TaggedError<AgentActivityRowDeletePersistenceError>()(
  "AgentActivityRowDeletePersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowPruneTerminalPersistenceError extends Schema.TaggedError<AgentActivityRowPruneTerminalPersistenceError>()(
  "AgentActivityRowPruneTerminalPersistenceError",
  {
    updatedBefore: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prune terminal agent activity rows updated before ${this.updatedBefore}.`;
  }
}

export class AgentActivityRowListPersistenceError extends Schema.TaggedError<AgentActivityRowListPersistenceError>()(
  "AgentActivityRowListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list agent activity state for user ${this.userId}.`;
  }
}

export class AgentActivityRows extends Context.Service<
  AgentActivityRows,
  {
    /** Returns the state this replaced, if any. */
    readonly upsert: (input: {
      readonly environmentPublicKey: string;
      readonly state: RelayAgentActivityState;
    }) => Effect.Effect<RelayAgentActivityState | null, AgentActivityRowUpsertPersistenceError>;
    readonly pruneTerminal: (input: {
      readonly updatedBefore: string;
    }) => Effect.Effect<void, AgentActivityRowPruneTerminalPersistenceError>;
    readonly remove: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
    }) => Effect.Effect<void, AgentActivityRowDeletePersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayAgentActivityState>,
      AgentActivityRowListPersistenceError
    >;
    readonly getForUserThread: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly threadId: string;
    }) => Effect.Effect<RelayAgentActivityState | null, AgentActivityRowListPersistenceError>;
  }
>()("t3code-relay/agentActivity/AgentActivityRows") {}

export const layer = Layer.effect(
  AgentActivityRows,
  Effect.map(AgentActivityPersistence, (store) => AgentActivityRows.of(store)),
);
