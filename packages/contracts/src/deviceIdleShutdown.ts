import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DeviceIdleShutdownMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 1440 }),
);
export type DeviceIdleShutdownMinutes = typeof DeviceIdleShutdownMinutes.Type;
export const DEFAULT_DEVICE_IDLE_SHUTDOWN_MINUTES: DeviceIdleShutdownMinutes = 10;

/**
 * Minutes a simulator or emulator this server booted may sit unused before it
 * is shut down. `null` keeps them running. Devices booted outside styal are
 * never shut down.
 */
export const DeviceIdleShutdownSetting = Schema.NullOr(DeviceIdleShutdownMinutes).pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_DEVICE_IDLE_SHUTDOWN_MINUTES)),
);

/** Choices the settings pickers offer; `null` keeps devices running. */
export const DEVICE_IDLE_SHUTDOWN_CHOICES: ReadonlyArray<DeviceIdleShutdownMinutes | null> = [
  5,
  10,
  30,
  60,
  null,
];

/** Settings label for the idle shutdown period. */
export const deviceIdleShutdownLabel = (minutes: DeviceIdleShutdownMinutes | null) =>
  minutes === null
    ? "Never"
    : minutes % 60 === 0
      ? `After ${minutes / 60} h`
      : `After ${minutes} min`;
