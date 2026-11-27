import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ManagedTunnelLimitPersistence } from "../persistence/TunnelPersistence.ts";

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedError<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["transaction", "lock-user", "load-limit", "count-tunnels"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedError<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxTunnels: Schema.Number,
    activeTunnels: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    /** Runs `reserve` only while the user is under their limit, serialized per user in one transaction. */
    readonly withCapacity: <A, E, R>(
      input: { readonly userId: string; readonly environmentId: string },
      reserve: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError, R>;
    /** The user's manual cap, which replaces the default and any T3 Chat plan cap. */
    readonly getOverride: (input: {
      readonly userId: string;
    }) => Effect.Effect<number | null, ManagedTunnelLimitPersistenceError>;
  }
>()("t3code-relay/environments/ManagedTunnelLimits") {}

export const layer = Layer.effect(
  ManagedTunnelLimits,
  Effect.map(ManagedTunnelLimitPersistence, (store) => ManagedTunnelLimits.of(store)),
);
