import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateSchema } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayAuthSessions, relayLiveActivities, relayMobileDevices } from "./schema.ts";
import { DeviceNotOwnedBySession, DeviceSessionRevoked } from "../agentActivity/Devices.ts";

import { lockDeviceOwnership } from "./PostgresDevices.ts";
import {
  LiveActivityRegistrationPersistenceError,
  LiveActivityTargetListPersistenceError,
  LiveActivityIdleTargetListPersistenceError,
  LiveActivityDeliveryMarkPersistenceError,
  type TargetRow,
} from "../agentActivity/LiveActivities.ts";
import { LiveActivityPersistence } from "./RegistrationPersistence.ts";

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJsonValue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeRelayAgentActivityAggregateStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return LiveActivityPersistence.of({
    register: Effect.fn("relay.live_activities.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.registration.deviceId,
      });
      const register = Effect.gen(function* () {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const registration = input.registration;
        const [current] = yield* db
          .select({
            activityPushToken: relayLiveActivities.activityPushToken,
            remoteStartedAt: relayLiveActivities.remoteStartedAt,
          })
          .from(relayLiveActivities)
          .where(
            and(
              eq(relayLiveActivities.userId, input.userId),
              eq(relayLiveActivities.deviceId, registration.deviceId),
            ),
          );
        // Foreground token refresh must retain the original arming time or grace can swallow an owed end event.
        const armedAt =
          (current?.activityPushToken === registration.activityPushToken
            ? current.remoteStartedAt
            : null) ?? updatedAt;

        yield* db
          .update(relayLiveActivities)
          .set({
            activityPushToken: null,
            remoteStartQueuedAt: null,
            remoteStartedAt: null,
            endedAt: updatedAt,
            updatedAt,
          })
          .where(eq(relayLiveActivities.activityPushToken, registration.activityPushToken));

        yield* db
          .insert(relayLiveActivities)
          .values({
            userId: input.userId,
            deviceId: registration.deviceId,
            activityPushToken: registration.activityPushToken,
            remoteStartQueuedAt: null,
            remoteStartedAt: armedAt,
            endedAt: null,
            lastAggregateJson: null,
            lastLiveActivityDeliveryAt: null,
            createdAt: updatedAt,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: [relayLiveActivities.userId, relayLiveActivities.deviceId],
            set: {
              activityPushToken: registration.activityPushToken,
              remoteStartQueuedAt: null,
              remoteStartedAt: armedAt,
              endedAt: null,
              lastAggregateJson: null,
              lastLiveActivityDeliveryAt: null,
              updatedAt,
            },
          });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new LiveActivityRegistrationPersistenceError({
              userId: input.userId,
              deviceId: input.registration.deviceId,
              cause,
            }),
        ),
      );
      const sessionId = input.sessionId;
      if (sessionId === undefined) return yield* register;
      yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            // Same session lock as Devices.register: session revocation and
            // account deletion delete this row before registrations.
            const live = yield* db
              .select({ sessionId: relayAuthSessions.sessionId })
              .from(relayAuthSessions)
              .where(
                and(
                  eq(relayAuthSessions.sessionId, sessionId),
                  eq(relayAuthSessions.userId, input.userId),
                  gt(relayAuthSessions.expiresAt, DateTime.formatIso(yield* DateTime.now)),
                ),
              )
              .for("update");
            if (live.length === 0) return yield* new DeviceSessionRevoked({});
            yield* lockDeviceOwnership(db, input.userId, input.registration.deviceId);
            const owned = yield* db
              .select({ deviceId: relayMobileDevices.deviceId })
              .from(relayMobileDevices)
              .where(
                and(
                  eq(relayMobileDevices.userId, input.userId),
                  eq(relayMobileDevices.deviceId, input.registration.deviceId),
                  eq(relayMobileDevices.sessionId, sessionId),
                ),
              )
              .for("update");
            if (owned.length === 0) return yield* new DeviceNotOwnedBySession({});
            yield* register;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "DeviceSessionRevoked" ||
            cause._tag === "DeviceNotOwnedBySession" ||
            cause._tag === "LiveActivityRegistrationPersistenceError"
              ? cause
              : new LiveActivityRegistrationPersistenceError({
                  userId: input.userId,
                  deviceId: input.registration.deviceId,
                  cause,
                }),
          ),
        );
    }),

    listTargets: Effect.fn("relay.live_activities.list_targets")(function* (input) {
      return yield* db
        .select({
          device_id: relayMobileDevices.deviceId,
          user_id: relayMobileDevices.userId,
          platform: relayMobileDevices.platform,
          ios_major_version: relayMobileDevices.iosMajorVersion,
          app_version: relayMobileDevices.appVersion,
          bundle_id: relayMobileDevices.bundleId,
          aps_environment: relayMobileDevices.apsEnvironment,
          push_token: relayMobileDevices.pushToken,
          push_to_start_token: relayMobileDevices.pushToStartToken,
          preferences_json: relayMobileDevices.preferencesJson,
          activity_push_token: relayLiveActivities.activityPushToken,
          remote_start_queued_at: relayLiveActivities.remoteStartQueuedAt,
          remote_started_at: relayLiveActivities.remoteStartedAt,
          ended_at: relayLiveActivities.endedAt,
          last_aggregate_json: relayLiveActivities.lastAggregateJson,
          last_live_activity_delivery_at: relayLiveActivities.lastLiveActivityDeliveryAt,
        })
        .from(relayMobileDevices)
        .leftJoin(
          relayLiveActivities,
          and(
            eq(relayLiveActivities.userId, relayMobileDevices.userId),
            eq(relayLiveActivities.deviceId, relayMobileDevices.deviceId),
          ),
        )
        .where(
          and(
            eq(relayMobileDevices.userId, input.userId),
            // Delivery ends with the session, without waiting for pruning to remove the rows.
            sql`(${relayMobileDevices.sessionId} is null or exists (
              select 1 from ${relayAuthSessions}
              where ${relayAuthSessions.sessionId} = ${relayMobileDevices.sessionId}
                and ${relayAuthSessions.expiresAt} > ${DateTime.formatIso(yield* DateTime.now)}
            ))`,
          ),
        )
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows,
              (row) =>
                Effect.all({
                  preferences_json: encodeJsonValue(row.preferences_json),
                  last_aggregate_json:
                    row.last_aggregate_json === null
                      ? Effect.succeed(null)
                      : encodeJsonValue(row.last_aggregate_json),
                }).pipe(
                  Effect.map((json) => ({
                    ...row,
                    ...json,
                  })),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((rows): ReadonlyArray<TargetRow> => rows),
          Effect.mapError(
            (cause) =>
              new LiveActivityTargetListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),

    listIdleArmedTargets: Effect.fn("relay.live_activities.list_idle_armed_targets")(
      function* (input) {
        return yield* db
          .select({
            user_id: relayLiveActivities.userId,
            device_id: relayLiveActivities.deviceId,
          })
          .from(relayLiveActivities)
          .where(
            and(
              isNotNull(relayLiveActivities.activityPushToken),
              sql`coalesce(${relayLiveActivities.lastLiveActivityDeliveryAt}, ${relayLiveActivities.remoteStartedAt}, ${relayLiveActivities.updatedAt}) < ${input.deliveredBefore}`,
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new LiveActivityIdleTargetListPersistenceError({
                  deliveredBefore: input.deliveredBefore,
                  cause,
                }),
            ),
          );
      },
    ),

    markDelivery: Effect.fn("relay.live_activities.mark_delivery")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
        "relay.delivery.kind": input.kind,
      });
      yield* Effect.gen(function* () {
        const aggregateJson =
          input.aggregate === null
            ? null
            : yield* encodeRelayAgentActivityAggregateStateJson(input.aggregate).pipe(
                Effect.flatMap(decodeJsonString),
                Effect.map(Function.cast<unknown, RelayAgentActivityAggregateState>),
              );

        yield* db
          .insert(relayLiveActivities)
          .values({
            userId: input.userId,
            deviceId: input.deviceId,
            remoteStartedAt: null,
            remoteStartQueuedAt: null,
            endedAt: input.kind === "live_activity_end" ? input.deliveredAt : null,
            lastAggregateJson: aggregateJson,
            lastLiveActivityDeliveryAt: input.deliveredAt,
            createdAt: input.deliveredAt,
            updatedAt: input.deliveredAt,
          })
          .onConflictDoUpdate({
            target: [relayLiveActivities.userId, relayLiveActivities.deviceId],
            set: {
              activityPushToken:
                input.kind === "live_activity_update"
                  ? sql`${relayLiveActivities.activityPushToken}`
                  : null,
              remoteStartedAt: sql`coalesce(
                      ${relayLiveActivities.remoteStartedAt},
                      excluded.remote_started_at
                    )`,
              remoteStartQueuedAt: null,
              endedAt:
                input.kind === "live_activity_end"
                  ? input.deliveredAt
                  : relayLiveActivities.endedAt,
              lastAggregateJson: aggregateJson,
              lastLiveActivityDeliveryAt: input.deliveredAt,
              updatedAt: input.deliveredAt,
            },
          });
      }).pipe(
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
    }),

    invalidateDeliveryToken: Effect.fn("relay.live_activities.invalidate_delivery_token")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.deviceId,
          "relay.delivery.kind": input.kind,
        });
        yield* Effect.gen(function* () {
          if (input.kind === "push_notification") {
            yield* db
              .update(relayMobileDevices)
              .set({
                pushToken: null,
                updatedAt: input.invalidatedAt,
              })
              .where(
                and(
                  eq(relayMobileDevices.userId, input.userId),
                  eq(relayMobileDevices.deviceId, input.deviceId),
                ),
              );
            return;
          }

          yield* db
            .update(relayLiveActivities)
            .set({
              activityPushToken: null,
              remoteStartQueuedAt: null,
              remoteStartedAt: null,
              endedAt: input.invalidatedAt,
              updatedAt: input.invalidatedAt,
            })
            .where(
              and(
                eq(relayLiveActivities.userId, input.userId),
                eq(relayLiveActivities.deviceId, input.deviceId),
              ),
            );
        }).pipe(
          Effect.mapError(
            (cause) =>
              new LiveActivityDeliveryMarkPersistenceError({
                operation: "invalidate-delivery-token",
                userId: input.userId,
                deviceId: input.deviceId,
                kind: input.kind,
                cause,
              }),
          ),
        );
      },
    ),
  });
});

export const layer = Layer.effect(LiveActivityPersistence, make);
