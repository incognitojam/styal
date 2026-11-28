import type { RelayManagedEndpointOrigin } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ManagedEndpointAllocation } from "../environments/ManagedEndpointAllocations.ts";

export type TunnelOperationDesired =
  | { readonly kind: "provision"; readonly origin: RelayManagedEndpointOrigin }
  | {
      readonly kind: "deprovision";
      readonly target: Pick<ManagedEndpointAllocation, "tunnelId" | "dnsRecordId">;
    }
  | {
      readonly kind: "release";
      readonly expectedTunnelId?: string;
      readonly expectedInactiveBefore?: string;
      readonly expectedStatus?: "inactive" | "down";
      readonly markReleased?: boolean;
    };

export interface TunnelOperationIntent {
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  readonly tunnelName: string;
  readonly desired: TunnelOperationDesired;
}

export interface TunnelOperation extends TunnelOperationIntent {
  readonly operationId: string;
  readonly resumed?: boolean;
  readonly phase: string;
  readonly resources: Readonly<Record<string, string>>;
}

export class TunnelOperationPersistenceError extends Schema.TaggedError<TunnelOperationPersistenceError>()(
  "TunnelOperationPersistenceError",
  { cause: Schema.Defect() },
) {}

export class TunnelOperationPersistence extends Context.Service<
  TunnelOperationPersistence,
  {
    /** Teardown supersedes pending work; a new origin supersedes provisioning. Release waits. */
    readonly begin: (
      intent: TunnelOperationIntent,
      expectedOperationId?: string,
    ) => Effect.Effect<TunnelOperation | null, TunnelOperationPersistenceError>;
    readonly advance: (
      operationId: string,
      phase: string,
      resources?: Readonly<Record<string, string>>,
    ) => Effect.Effect<boolean, TunnelOperationPersistenceError>;
    readonly complete: (
      operationId: string,
      expectedPhase?: string,
    ) => Effect.Effect<boolean, TunnelOperationPersistenceError>;
    readonly pending: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<TunnelOperation>, TunnelOperationPersistenceError>;
  }
>()("t3code-relay/persistence/TunnelOperationPersistence") {}

// The operation id authorizes local allocation transitions, never remote calls.
export class TunnelOperationExecution extends Context.Service<
  TunnelOperationExecution,
  TunnelOperation
>()("t3code-relay/persistence/TunnelOperationPersistence/TunnelOperationExecution") {}

export class TunnelOperationResume extends Context.Service<TunnelOperationResume, string>()(
  "t3code-relay/persistence/TunnelOperationPersistence/TunnelOperationResume",
) {}
