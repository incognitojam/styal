import type { RelayManagedEndpoint, RelayManagedEndpointOrigin } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isManagedEndpointHostname, managedEndpointForHostname } from "../deploymentConfig.ts";

import { ManagedEndpointAllocationPersistence } from "../persistence/TunnelPersistence.ts";

export interface ManagedEndpointAllocation {
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  readonly tunnelId: string | null;
  readonly tunnelName: string;
  readonly dnsRecordId: string | null;
  readonly readyAt: string | null;
  readonly origin: RelayManagedEndpointOrigin | null;
  readonly updatedAt: string;
  readonly generation: number;
  readonly tunnelReleasedAt: string | null;
}

export interface ManagedEndpointTunnelAllocation extends ManagedEndpointAllocation {
  readonly recoveryEnabled: boolean;
}

export function resolveReadyManagedEndpoint(input: {
  readonly allocation: ManagedEndpointAllocation;
  readonly baseDomain: string | undefined;
}): RelayManagedEndpoint | null {
  if (
    !input.baseDomain ||
    input.allocation.readyAt === null ||
    input.allocation.tunnelId === null ||
    input.allocation.dnsRecordId === null ||
    !isManagedEndpointHostname(input.allocation.hostname, input.baseDomain)
  ) {
    return null;
  }
  return managedEndpointForHostname(input.allocation.hostname);
}

export class ManagedEndpointAllocationPersistenceError extends Schema.TaggedError<ManagedEndpointAllocationPersistenceError>()(
  "ManagedEndpointAllocationPersistenceError",
  {
    operation: Schema.Literals([
      "get",
      "reserve",
      "record-tunnel",
      "record-dns",
      "mark-ready",
      "enable-recovery",
      "list-tunnels",
      "lock-tunnel",
      "claim-release",
      "claim-deprovision",
      "remove-claimed",
      "get-by-tunnel-name",
    ]),
    stage: Schema.Literals(["database-request", "resolve-reservation"]),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint allocation '${this.operation}' failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

interface ManagedEndpointAllocationKey {
  readonly userId: string;
  readonly environmentId: string;
}

interface ReserveManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly hostname: string;
  readonly tunnelName: string;
}

interface RecordManagedEndpointTunnelInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
}

interface RecordManagedEndpointDnsInput extends ManagedEndpointAllocationKey {
  readonly dnsRecordId: string;
  readonly tunnelId: string;
  readonly generation: number;
}

interface MarkManagedEndpointReadyInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
  readonly origin: RelayManagedEndpointOrigin;
}

interface ClaimManagedEndpointReleaseInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
  readonly markReleased?: boolean;
}

interface EnableManagedEndpointRecoveryInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly environmentPublicKey: string;
  readonly origin: RelayManagedEndpointOrigin;
}

interface ClaimManagedEndpointDeprovisionInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

interface RemoveClaimedManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

export class ManagedEndpointAllocations extends Context.Service<
  ManagedEndpointAllocations,
  {
    readonly get: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    readonly getByTunnelName: (
      tunnelName: string,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    readonly reserve: (
      input: ReserveManagedEndpointAllocationInput,
    ) => Effect.Effect<ManagedEndpointAllocation, ManagedEndpointAllocationPersistenceError>;
    readonly recordTunnel: (
      input: RecordManagedEndpointTunnelInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly recordDns: (
      input: RecordManagedEndpointDnsInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly markReady: (
      input: MarkManagedEndpointReadyInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
    readonly enableRecovery: (
      input: EnableManagedEndpointRecoveryInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
    readonly listByTunnelNames: (
      tunnelNames: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<ManagedEndpointTunnelAllocation>,
      ManagedEndpointAllocationPersistenceError
    >;
    /** Claim deletion only while tunnel and generation match, so concurrent provisioning keeps its new tunnel. */
    readonly claimRelease: (
      input: ClaimManagedEndpointReleaseInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly withClaimedTunnel: <A, E, R>(
      input: ClaimManagedEndpointReleaseInput,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | ManagedEndpointAllocationPersistenceError, R>;
    /** Return a teardown claim generation, or null if concurrent provisioning superseded the captured snapshot. */
    readonly claimDeprovision: (
      input: ClaimManagedEndpointDeprovisionInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly removeClaimed: (
      input: RemoveClaimedManagedEndpointAllocationInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
  }
>()("t3code-relay/environments/ManagedEndpointAllocations") {}

export const layer = Layer.effect(
  ManagedEndpointAllocations,
  Effect.map(ManagedEndpointAllocationPersistence, (store) => ManagedEndpointAllocations.of(store)),
);
