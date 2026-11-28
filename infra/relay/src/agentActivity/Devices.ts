import type {
  RelayClientDeviceRecord,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DevicePersistence } from "../persistence/RegistrationPersistence.ts";

export class DeviceSessionRevoked extends Schema.TaggedError<DeviceSessionRevoked>()(
  "DeviceSessionRevoked",
  {},
) {}

/** Live Activity registrations end with the device's session, so only that session may add one. */
export class DeviceNotOwnedBySession extends Schema.TaggedError<DeviceNotOwnedBySession>()(
  "DeviceNotOwnedBySession",
  {},
) {}

export class DeviceRegistrationPersistenceError extends Schema.TaggedError<DeviceRegistrationPersistenceError>()(
  "DeviceRegistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    stage: Schema.Literals(["claim-push-token", "claim-push-to-start-token", "upsert-device"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist mobile device registration for ${this.userId}/${this.deviceId} during ${this.stage}.`;
  }
}

export class DeviceUnregistrationPersistenceError extends Schema.TaggedError<DeviceUnregistrationPersistenceError>()(
  "DeviceUnregistrationPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    stage: Schema.Literals(["delete-live-activity", "delete-device"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister mobile device ${this.userId}/${this.deviceId} during ${this.stage}.`;
  }
}

export class DeviceListPersistenceError extends Schema.TaggedError<DeviceListPersistenceError>()(
  "DeviceListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list mobile devices for ${this.userId}.`;
  }
}

export class Devices extends Context.Service<
  Devices,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly sessionId?: string;
      readonly registration: RelayDeviceRegistrationRequest;
    }) => Effect.Effect<void, DeviceRegistrationPersistenceError | DeviceSessionRevoked>;
    readonly unregister: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<void, DeviceUnregistrationPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<RelayClientDeviceRecord>, DeviceListPersistenceError>;
  }
>()("t3code-relay/agentActivity/Devices") {}

export const layer = Layer.effect(
  Devices,
  Effect.map(DevicePersistence, (store) => Devices.of(store)),
);
