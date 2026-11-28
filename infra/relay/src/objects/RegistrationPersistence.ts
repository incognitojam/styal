import { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  DevicePersistence,
  LiveActivityPersistence,
} from "../persistence/RegistrationPersistence.ts";
import {
  FcmTokenPersistence,
  RegistrationCleanupPersistence,
  RegistrationCleanupReadError,
} from "../persistence/DeliveryTargetPersistence.ts";
import {
  DeviceRegistrationPersistenceError,
  DeviceUnregistrationPersistenceError,
  DeviceListPersistenceError,
  DeviceSessionRevoked,
  DeviceNotOwnedBySession,
} from "../agentActivity/Devices.ts";
import {
  LiveActivityRegistrationPersistenceError,
  LiveActivityTargetListPersistenceError,
  LiveActivityIdleTargetListPersistenceError,
  LiveActivityDeliveryMarkPersistenceError,
} from "../agentActivity/LiveActivities.ts";
import { FcmDeliveryError } from "../agentActivity/FcmDeliveries.ts";
import { RegistrationCoordinator } from "./RegistrationCoordinator.ts";
import type { RegistrationBindings } from "./RegistrationCoordinator.ts";
import { canonicalJson } from "./storage.ts";

const isSessionRevoked = Schema.is(DeviceSessionRevoked);
const isNotOwned = Schema.is(DeviceNotOwnedBySession);
const aggregateJson = Schema.fromJsonString(RelayAgentActivityAggregateState);
const encodeAggregate = Schema.encodeEffect(aggregateJson);
const decodeAggregate = Schema.decodeEffect(aggregateJson);

export const registrationLayer = (bindings: RegistrationBindings) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const coordinator = new RegistrationCoordinator(bindings);
      const devices = DevicePersistence.of({
        register: Effect.fn("relay.object_devices.register")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const id = yield* random.uuidV4();
          return yield* Effect.tryPromise({
            try: () =>
              coordinator.register(
                input.userId,
                {
                  kind: "device",
                  registration: input.registration,
                  ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
                },
                id,
                now,
              ),
            catch: (cause) =>
              isSessionRevoked(cause)
                ? cause
                : new DeviceRegistrationPersistenceError({
                    userId: input.userId,
                    deviceId: input.registration.deviceId,
                    stage: "upsert-device",
                    cause,
                  }),
          });
        }),
        unregister: Effect.fn("relay.object_devices.unregister")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* Effect.tryPromise({
            try: () =>
              coordinator.mutate(
                input.userId,
                input.deviceId,
                { kind: "remove", deviceId: input.deviceId },
                now,
              ),
            catch: (cause) =>
              new DeviceUnregistrationPersistenceError({ ...input, stage: "delete-device", cause }),
          });
        }),
        listForUser: Effect.fn("relay.object_devices.list")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* Effect.tryPromise({
            try: () => coordinator.views(input.userId, now, true, false),
            catch: (cause) => new DeviceListPersistenceError({ ...input, cause }),
          });
          return rows.flatMap(({ deviceId, candidate }) => {
            const device = candidate.device;
            if (!device) return [];
            const r = device.registration;
            return [
              {
                deviceId,
                label: r.label,
                platform: r.platform,
                iosMajorVersion: r.iosMajorVersion ?? null,
                androidApiLevel: r.androidApiLevel ?? null,
                appVersion: r.appVersion ?? null,
                notifications: {
                  enabled: r.preferences.notificationsEnabled,
                  notifyOnApproval: r.preferences.notifyOnApproval,
                  notifyOnInput: r.preferences.notifyOnInput,
                  notifyOnCompletion: r.preferences.notifyOnCompletion,
                  notifyOnFailure: r.preferences.notifyOnFailure,
                },
                liveActivities: { enabled: r.preferences.liveActivitiesEnabled },
                updatedAt: device.updatedAt,
              },
            ];
          });
        }),
      });
      const activities = LiveActivityPersistence.of({
        register: Effect.fn("relay.object_live_activities.register")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const id = yield* random.uuidV4();
          return yield* Effect.tryPromise({
            try: () =>
              coordinator.register(
                input.userId,
                {
                  kind: "activity",
                  registration: input.registration,
                  ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
                },
                id,
                now,
              ),
            catch: (cause) =>
              isSessionRevoked(cause) || isNotOwned(cause)
                ? cause
                : new LiveActivityRegistrationPersistenceError({
                    userId: input.userId,
                    deviceId: input.registration.deviceId,
                    cause,
                  }),
          });
        }),
        listTargets: Effect.fn("relay.object_live_activities.list_targets")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* Effect.tryPromise({
            try: () => coordinator.views(input.userId, now),
            catch: (cause) => new LiveActivityTargetListPersistenceError({ ...input, cause }),
          });
          return rows.flatMap(({ deviceId, candidate }) => {
            if (!candidate.device) return [];
            const device = candidate.device;
            const r = device.registration;
            const a = candidate.activity;
            return [
              {
                user_id: input.userId,
                device_id: deviceId,
                platform: r.platform,
                ios_major_version: r.iosMajorVersion ?? null,
                app_version: r.appVersion ?? null,
                bundle_id: r.bundleId ?? null,
                aps_environment: r.apsEnvironment ?? null,
                push_token: device.push?.token ?? null,
                push_to_start_token: device.start?.token ?? null,
                preferences_json: canonicalJson(r.preferences),
                activity_push_token: a?.token?.token ?? null,
                remote_start_queued_at: a?.remoteStartQueuedAt ?? null,
                remote_started_at: a?.remoteStartedAt ?? null,
                ended_at: a?.endedAt ?? null,
                last_aggregate_json: a?.aggregate ? canonicalJson(a.aggregate) : null,
                last_live_activity_delivery_at: a?.deliveredAt ?? null,
              },
            ];
          });
        }),
        listIdleArmedTargets: Effect.fn("relay.object_live_activities.list_idle_armed")(
          function* (input) {
            const now = DateTime.formatIso(yield* DateTime.now);
            const result = yield* Effect.tryPromise({
              try: async () => {
                const targets = [];
                let unavailable = 0;
                for (const userId of await coordinator.accountIds(() => {
                  unavailable++;
                })) {
                  try {
                    for (const row of await coordinator.views(userId, now, true)) {
                      const a = row.candidate.activity;
                      if (
                        a?.token &&
                        (a.deliveredAt ?? a.remoteStartedAt ?? a.updatedAt) < input.deliveredBefore
                      )
                        targets.push({ user_id: userId, device_id: row.deviceId });
                    }
                  } catch {
                    unavailable++;
                  }
                }
                return { targets, unavailable };
              },
              catch: (cause) => new LiveActivityIdleTargetListPersistenceError({ ...input, cause }),
            });
            if (result.unavailable)
              yield* Effect.logWarning(
                "Idle Live Activity maintenance skipped unavailable accounts",
                { count: result.unavailable },
              );
            return result.targets;
          },
        ),
        markDelivery: Effect.fn("relay.object_live_activities.mark_delivery")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const aggregate =
            input.aggregate === null
              ? null
              : yield* encodeAggregate(input.aggregate).pipe(
                  Effect.flatMap(decodeAggregate),
                  Effect.mapError(
                    (cause) =>
                      new LiveActivityDeliveryMarkPersistenceError({
                        operation: "mark-delivery",
                        userId: input.userId,
                        deviceId: input.deviceId,
                        kind: input.kind,
                        cause,
                      }),
                  ),
                );
          return yield* Effect.tryPromise({
            try: () =>
              coordinator.mutate(
                input.userId,
                input.deviceId,
                {
                  kind: "mark",
                  deviceId: input.deviceId,
                  end: input.kind === "live_activity_end",
                  keepToken: input.kind === "live_activity_update",
                  aggregate,
                  now: input.deliveredAt,
                },
                now,
              ),
            catch: (cause) =>
              new LiveActivityDeliveryMarkPersistenceError({
                operation: "mark-delivery",
                userId: input.userId,
                deviceId: input.deviceId,
                kind: input.kind,
                cause,
              }),
          });
        }),
        invalidateDeliveryToken: Effect.fn("relay.object_live_activities.invalidate_token")(
          function* (input) {
            const now = DateTime.formatIso(yield* DateTime.now);
            return yield* Effect.tryPromise({
              try: () =>
                coordinator.mutate(
                  input.userId,
                  input.deviceId,
                  {
                    kind: "invalidate",
                    deviceId: input.deviceId,
                    push: input.kind === "push_notification",
                    now: input.invalidatedAt,
                  },
                  now,
                ),
              catch: (cause) =>
                new LiveActivityDeliveryMarkPersistenceError({
                  operation: "invalidate-delivery-token",
                  userId: input.userId,
                  deviceId: input.deviceId,
                  kind: input.kind,
                  cause,
                }),
            });
          },
        ),
      });
      return Context.make(DevicePersistence, devices).pipe(
        Context.add(LiveActivityPersistence, activities),
        Context.add(
          FcmTokenPersistence,
          FcmTokenPersistence.of({
            invalidate: Effect.fn("relay.object_fcm.invalidate")(function* (input) {
              const now = DateTime.formatIso(yield* DateTime.now);
              return yield* Effect.tryPromise({
                try: () =>
                  coordinator.mutate(
                    input.userId,
                    input.deviceId,
                    {
                      kind: "invalidate",
                      deviceId: input.deviceId,
                      push: true,
                      token: input.token,
                    },
                    now,
                  ),
                catch: (cause) => new FcmDeliveryError({ operation: "invalidate-token", cause }),
              });
            }),
          }),
        ),
        Context.add(
          RegistrationCleanupPersistence,
          RegistrationCleanupPersistence.of({
            listTargets: Effect.fn("relay.object_cleanup.targets")(function* (scope) {
              const now = DateTime.formatIso(yield* DateTime.now);
              return yield* Effect.tryPromise({
                try: () => coordinator.cleanup(scope, now),
                catch: (cause) => new RegistrationCleanupReadError({ cause }),
              });
            }),
          }),
        ),
      );
    }),
  );
