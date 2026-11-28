import type {
  RelayAgentActivityAggregateState,
  RelayDeliveryKind,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { RelayDeliveryKind as RelayDeliveryKindSchema } from "@t3tools/contracts/relay";
import { DeviceNotOwnedBySession, DeviceSessionRevoked } from "./Devices.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { LiveActivityPersistence } from "../persistence/RegistrationPersistence.ts";

export class LiveActivityRegistrationPersistenceError extends Schema.TaggedError<LiveActivityRegistrationPersistenceError>()(
  "LiveActivityRegistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist Live Activity registration for user ${this.userId} and device ${this.deviceId}.`;
  }
}

export class LiveActivityTargetListPersistenceError extends Schema.TaggedError<LiveActivityTargetListPersistenceError>()(
  "LiveActivityTargetListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list Live Activity delivery targets for user ${this.userId}.`;
  }
}

export class LiveActivityIdleTargetListPersistenceError extends Schema.TaggedError<LiveActivityIdleTargetListPersistenceError>()(
  "LiveActivityIdleTargetListPersistenceError",
  {
    deliveredBefore: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list idle Live Activities delivered before ${this.deliveredBefore}.`;
  }
}

export class LiveActivityDeliveryMarkPersistenceError extends Schema.TaggedError<LiveActivityDeliveryMarkPersistenceError>()(
  "LiveActivityDeliveryMarkPersistenceError",
  {
    operation: Schema.Literals(["mark-delivery", "invalidate-delivery-token"]),
    userId: Schema.String,
    deviceId: Schema.String,
    kind: Schema.NullOr(RelayDeliveryKindSchema),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist Live Activity state during ${this.operation} for user ${this.userId} and device ${this.deviceId}.`;
  }
}

export interface DeviceRow {
  readonly user_id: string;
  readonly device_id: string;
  readonly platform: "ios" | "android";
  readonly ios_major_version: number | null;
  readonly app_version: string | null;
  readonly bundle_id: string | null;
  readonly aps_environment: "sandbox" | "production" | null;
  readonly push_token: string | null;
  readonly push_to_start_token: string | null;
  readonly preferences_json: string;
}

export interface LiveActivityRow {
  readonly activity_push_token: string | null;
  readonly remote_start_queued_at: string | null;
  readonly remote_started_at: string | null;
  readonly ended_at: string | null;
  readonly last_aggregate_json: string | null;
  readonly last_live_activity_delivery_at: string | null;
}

export type TargetRow = DeviceRow & LiveActivityRow;

export class LiveActivities extends Context.Service<
  LiveActivities,
  {
    /**
     * With a session, fails with DeviceNotOwnedBySession unless that session
     * registered the device, and with DeviceSessionRevoked once that session is
     * gone, as device registration does, so a request racing revocation or
     * account deletion cannot restore a removed registration.
     */
    readonly register: (input: {
      readonly userId: string;
      readonly sessionId?: string;
      readonly registration: RelayLiveActivityRegistrationRequest;
    }) => Effect.Effect<
      void,
      LiveActivityRegistrationPersistenceError | DeviceSessionRevoked | DeviceNotOwnedBySession
    >;
    readonly listTargets: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<TargetRow>, LiveActivityTargetListPersistenceError>;
    readonly listIdleArmedTargets: (input: {
      readonly deliveredBefore: string;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly user_id: string; readonly device_id: string }>,
      LiveActivityIdleTargetListPersistenceError
    >;
    readonly markDelivery: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly kind: Exclude<RelayDeliveryKind, "live_activity_start">;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly deliveredAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
    readonly invalidateDeliveryToken: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly kind: Exclude<RelayDeliveryKind, "live_activity_start">;
      readonly invalidatedAt: string;
    }) => Effect.Effect<void, LiveActivityDeliveryMarkPersistenceError>;
  }
>()("t3code-relay/agentActivity/LiveActivities") {}

export const layer = Layer.effect(
  LiveActivities,
  Effect.map(LiveActivityPersistence, (store) => LiveActivities.of(store)),
);
