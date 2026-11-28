import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import { AccountPersistence, SessionPersistence } from "../persistence/IdentityPersistence.ts";
import {
  DevicePersistence,
  LiveActivityPersistence,
} from "../persistence/RegistrationPersistence.ts";

import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";

class CleanupQueue extends Context.Service<
  CleanupQueue,
  {
    readonly ends: Array<
      Parameters<ApnsDeliveryQueue.ApnsDeliveryQueue["Service"]["enqueueLiveActivity"]>[0]
    >;
    readonly failNext: () => void;
    readonly queue: ApnsDeliveryQueue.ApnsDeliveryQueue["Service"];
  }
>()("t3code-relay/test/registrationPersistenceContract/CleanupQueue") {}

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

type Ports = AccountPersistence | SessionPersistence | DevicePersistence | LiveActivityPersistence;

const registration = (deviceId: string): RelayDeviceRegistrationRequest => ({
  deviceId,
  label: "Synthetic phone",
  platform: "ios",
  iosMajorVersion: 18,
  appVersion: "1.0.0",
  bundleId: "test.example.phone",
  apsEnvironment: "sandbox",
  pushToken: `push-${deviceId}`,
  pushToStartToken: `start-${deviceId}`,
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: false,
    notifyOnCompletion: true,
    notifyOnFailure: false,
    attendedAlertDelaySeconds: 90,
  },
});

const fixture = Effect.gen(function* () {
  const accounts = yield* AccountPersistence;
  const sessions = yield* SessionPersistence;
  const devices = yield* DevicePersistence;
  const activities = yield* LiveActivityPersistence;
  const userId = (yield* accounts.findOrCreateByEmail("phone@example.test")).userId;
  const session = yield* sessions.create({ userId, clientId: "t3-mobile", thumbprint: "key-a" });
  return { userId, sessionId: session.sessionId, sessions, devices, activities, accounts };
});

export function registrationPersistenceContract<E>(
  name: string,
  persistence: Layer.Layer<Ports, E, ApnsDeliveryQueue.ApnsDeliveryQueue>,
) {
  const probe = Layer.sync(CleanupQueue, () => {
    const ends: CleanupQueue["Service"]["ends"] = [];
    let failing = false;
    return {
      ends,
      failNext: () => {
        failing = true;
      },
      queue: ApnsDeliveryQueue.ApnsDeliveryQueue.of({
        enqueueLiveActivity: (input) =>
          Effect.gen(function* () {
            if (failing) {
              failing = false;
              return yield* new ApnsDeliveryQueue.ApnsDeliveryQueueSendError({
                operation: "send",
                jobId: "synthetic-job",
                kind: input.kind,
                userId: input.userId,
                deviceId: input.deviceId,
                cause: "Synthetic queue failure",
              });
            }
            ends.push(input);
            return {
              deviceId: input.deviceId,
              kind: input.kind,
              ok: true,
              queued: true,
              apnsStatus: null,
              apnsReason: null,
              apnsId: null,
            };
          }),
        enqueuePushNotification: () =>
          Effect.die("Unexpected notification in registration contract"),
      }),
    };
  });
  const layer = persistence.pipe(
    Layer.provideMerge(
      Layer.effect(
        ApnsDeliveryQueue.ApnsDeliveryQueue,
        Effect.map(CleanupQueue, (p) => p.queue),
      ).pipe(Layer.provideMerge(probe)),
    ),
  );
  describe(name, () => {
    it.effect(
      "preserves omitted tokens and routing while replacing metadata and all preferences",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const owner = { userId: f.userId, sessionId: f.sessionId };
          yield* f.devices.register({ ...owner, registration: registration("phone-a") });
          const before = (yield* f.devices.listForUser(owner))[0];
          expect(before).toMatchObject({
            deviceId: "phone-a",
            label: "Synthetic phone",
            platform: "ios",
            iosMajorVersion: 18,
            appVersion: "1.0.0",
            notifications: {
              enabled: true,
              notifyOnApproval: true,
              notifyOnInput: false,
              notifyOnCompletion: true,
              notifyOnFailure: false,
            },
            liveActivities: { enabled: true },
          });
          yield* TestClock.adjust("1 second");
          const preferences = {
            notificationsEnabled: false,
            liveActivitiesEnabled: false,
            notifyOnApproval: false,
            notifyOnInput: true,
            notifyOnCompletion: false,
            notifyOnFailure: true,
            attendedAlertDelaySeconds: 3600,
          };
          yield* f.devices.register({
            ...owner,
            registration: {
              deviceId: "phone-a",
              label: "Replacement",
              platform: "android",
              androidApiLevel: 35,
              preferences,
            },
          });
          expect(yield* f.devices.listForUser(owner)).toEqual([
            {
              deviceId: "phone-a",
              label: "Replacement",
              platform: "android",
              iosMajorVersion: null,
              androidApiLevel: 35,
              appVersion: null,
              notifications: {
                enabled: false,
                notifyOnApproval: false,
                notifyOnInput: true,
                notifyOnCompletion: false,
                notifyOnFailure: true,
              },
              liveActivities: { enabled: false },
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
          ]);
          const targets = yield* f.activities.listTargets(owner);
          expect(targets).toHaveLength(1);
          expect(targets[0]).toMatchObject({
            push_token: "push-phone-a",
            push_to_start_token: "start-phone-a",
            bundle_id: "test.example.phone",
            aps_environment: "sandbox",
            activity_push_token: null,
          });
          expect(yield* decodeJson(targets[0]!.preferences_json)).toEqual(preferences);
          expect(yield* f.devices.listForUser({ userId: "absent" })).toEqual([]);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "moves each token domain between devices and accounts without moving unrelated tokens",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const other = (yield* f.accounts.findOrCreateByEmail("other@example.test")).userId;
          yield* f.devices.register({ userId: f.userId, registration: registration("phone-a") });
          yield* f.activities.register({
            userId: f.userId,
            registration: {
              deviceId: "phone-a",
              activityPushToken: "activity-shared",
            },
          });
          yield* f.devices.register({
            userId: f.userId,
            registration: {
              ...registration("phone-b"),
              pushToken: "push-phone-a",
            },
          });
          expect(
            (yield* f.activities.listTargets({ userId: f.userId })).find(
              (t) => t.device_id === "phone-a",
            ),
          ).toMatchObject({
            push_token: null,
            push_to_start_token: "start-phone-a",
            activity_push_token: "activity-shared",
          });
          yield* f.devices.register({
            userId: other,
            registration: {
              ...registration("phone-c"),
              pushToken: "push-phone-a",
              pushToStartToken: "start-phone-a",
            },
          });
          yield* f.activities.register({
            userId: other,
            registration: {
              deviceId: "phone-c",
              activityPushToken: "activity-shared",
            },
          });
          const old = yield* f.activities.listTargets({ userId: f.userId });
          expect(old.find((t) => t.device_id === "phone-a")).toMatchObject({
            push_token: null,
            push_to_start_token: null,
            activity_push_token: null,
            remote_started_at: null,
            remote_start_queued_at: null,
            ended_at: DateTime.formatIso(yield* DateTime.now),
          });
          expect(old.find((t) => t.device_id === "phone-b")).toMatchObject({
            push_token: null,
            push_to_start_token: "start-phone-b",
          });
          expect((yield* f.activities.listTargets({ userId: other }))[0]).toMatchObject({
            push_token: "push-phone-a",
            push_to_start_token: "start-phone-a",
            activity_push_token: "activity-shared",
          });
        }).pipe(Effect.provide(layer)),
    );

    it.effect("keeps concurrent identical session registrations usable", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = {
          userId: f.userId,
          sessionId: f.sessionId,
          registration: registration("phone-a"),
        };
        yield* Effect.all([f.devices.register(input), f.devices.register(input)], {
          concurrency: "unbounded",
        });
        expect(yield* f.devices.listForUser(input)).toHaveLength(1);
        const live = {
          userId: f.userId,
          sessionId: f.sessionId,
          registration: { deviceId: "phone-a", activityPushToken: "activity-a" },
        };
        yield* Effect.all([f.activities.register(live), f.activities.register(live)], {
          concurrency: "unbounded",
        });
        expect((yield* f.activities.listTargets(input))[0]).toMatchObject({
          activity_push_token: "activity-a",
          remote_started_at: DateTime.formatIso(yield* DateTime.now),
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "checks session ownership before token claims and deletes activity when the device changes session",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const owner = { userId: f.userId, sessionId: f.sessionId };
          yield* f.devices.register({ ...owner, registration: registration("phone-a") });
          yield* f.activities.register({
            ...owner,
            registration: { deviceId: "phone-a", activityPushToken: "activity-a" },
          });
          const second = yield* f.sessions.create({
            userId: f.userId,
            clientId: "t3-mobile",
            thumbprint: "key-b",
          });
          expect(
            Result.getFailure(
              yield* f.activities
                .register({
                  userId: f.userId,
                  sessionId: second.sessionId,
                  registration: { deviceId: "phone-a", activityPushToken: "activity-b" },
                })
                .pipe(Effect.result),
            ),
          ).toMatchObject({ _tag: "Some", value: { _tag: "DeviceNotOwnedBySession" } });
          expect(
            Result.getFailure(
              yield* f.devices
                .register({
                  userId: f.userId,
                  sessionId: "missing",
                  registration: { ...registration("phone-b"), pushToken: "push-phone-a" },
                })
                .pipe(Effect.result),
            ),
          ).toMatchObject({ _tag: "Some", value: { _tag: "DeviceSessionRevoked" } });
          expect((yield* f.activities.listTargets(owner))[0]).toMatchObject({
            push_token: "push-phone-a",
            activity_push_token: "activity-a",
          });
          yield* f.devices.register({
            userId: f.userId,
            sessionId: second.sessionId,
            registration: registration("phone-a"),
          });
          expect((yield* f.activities.listTargets(owner))[0]?.activity_push_token).toBeNull();
          expect(yield* f.sessions.revoke(owner)).toBe(true);
          expect(yield* f.devices.listForUser(owner)).toHaveLength(1);
          expect(yield* f.sessions.revoke({ userId: f.userId, sessionId: second.sessionId })).toBe(
            true,
          );
          expect(yield* f.devices.listForUser(owner)).toEqual([]);
          expect(yield* f.activities.listTargets(owner)).toEqual([]);
          expect(
            Result.getFailure(
              yield* f.activities
                .register({
                  ...owner,
                  registration: { deviceId: "phone-a", activityPushToken: "activity-a" },
                })
                .pipe(Effect.result),
            ),
          ).toMatchObject({ _tag: "Some", value: { _tag: "DeviceSessionRevoked" } });
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "retains authority when an end cannot be queued and retries only the revoked session's targets",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const q = yield* CleanupQueue;
          const owner = { userId: f.userId, sessionId: f.sessionId };
          yield* f.devices.register({ ...owner, registration: registration("phone-a") });
          yield* f.activities.register({
            ...owner,
            registration: { deviceId: "phone-a", activityPushToken: "activity-a" },
          });
          yield* f.devices.register({ userId: f.userId, registration: registration("legacy") });
          yield* f.activities.register({
            userId: f.userId,
            registration: { deviceId: "legacy", activityPushToken: "activity-legacy" },
          });
          q.failNext();
          expect(Result.isFailure(yield* f.sessions.revoke(owner).pipe(Effect.result))).toBe(true);
          expect(yield* f.sessions.isLive(owner)).toBe(true);
          expect(yield* f.devices.listForUser(owner)).toHaveLength(2);
          expect(
            (yield* f.activities.listTargets(owner)).find((t) => t.device_id === "phone-a")
              ?.activity_push_token,
          ).toBe("activity-a");
          expect(q.ends).toEqual([]);
          expect(yield* f.sessions.revoke(owner)).toBe(true);
          expect(q.ends).toEqual([
            {
              userId: f.userId,
              deviceId: "phone-a",
              token: "activity-a",
              bundleId: "test.example.phone",
              apsEnvironment: "sandbox",
              kind: "live_activity_end",
              aggregate: null,
              registrationRemoved: true,
            },
          ]);
          expect(yield* f.sessions.isLive(owner)).toBe(false);
          expect((yield* f.activities.listTargets(owner)).map((t) => t.device_id)).toEqual([
            "legacy",
          ]);
          expect(yield* f.sessions.revoke(owner)).toBe(false);
          expect(q.ends).toHaveLength(1);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "filters expired sessions before pruning and preserves legacy registrations during removal",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const owner = { userId: f.userId, sessionId: f.sessionId };
          yield* f.devices.register({ ...owner, registration: registration("phone-a") });
          yield* f.activities.register({
            ...owner,
            registration: { deviceId: "phone-a", activityPushToken: "activity-a" },
          });
          yield* f.devices.register({ userId: f.userId, registration: registration("legacy") });
          yield* f.activities.register({
            userId: f.userId,
            registration: { deviceId: "legacy", activityPushToken: "activity-legacy" },
          });
          yield* TestClock.adjust("90 days");
          expect((yield* f.activities.listTargets(owner)).map((t) => t.device_id)).toEqual([
            "legacy",
          ]);
          expect(yield* f.devices.listForUser(owner)).toHaveLength(2);
          expect(
            Result.getFailure(
              yield* f.devices
                .register({ ...owner, registration: registration("phone-a") })
                .pipe(Effect.result),
            ),
          ).toMatchObject({ _tag: "Some", value: { _tag: "DeviceSessionRevoked" } });
          yield* f.sessions.pruneExpired;
          expect((yield* CleanupQueue).ends).toEqual([
            {
              userId: f.userId,
              deviceId: "phone-a",
              token: "activity-a",
              bundleId: "test.example.phone",
              apsEnvironment: "sandbox",
              kind: "live_activity_end",
              aggregate: null,
              registrationRemoved: true,
            },
          ]);
          expect((yield* f.devices.listForUser(owner)).map((t) => t.deviceId)).toEqual(["legacy"]);
          yield* f.devices.unregister({ userId: "absent", deviceId: "legacy" });
          expect((yield* f.activities.listTargets(owner))[0]?.activity_push_token).toBe(
            "activity-legacy",
          );
          yield* f.devices.unregister({ userId: f.userId, deviceId: "legacy" });
          yield* f.devices.unregister({ userId: f.userId, deviceId: "legacy" });
          expect(yield* f.activities.listTargets(owner)).toEqual([]);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "preserves arming time on refresh, strict idle cutoff, ended state and token invalidation",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const owner = { userId: f.userId, deviceId: "phone-a" };
          yield* f.devices.register({
            userId: f.userId,
            registration: registration(owner.deviceId),
          });
          const input = {
            userId: f.userId,
            registration: { deviceId: owner.deviceId, activityPushToken: "activity-a" },
          };
          yield* f.activities.register(input);
          const armedAt = DateTime.formatIso(yield* DateTime.now);
          expect(yield* f.activities.listIdleArmedTargets({ deliveredBefore: armedAt })).toEqual(
            [],
          );
          yield* TestClock.adjust("1 second");
          yield* f.activities.register(input);
          expect((yield* f.activities.listTargets(owner))[0]?.remote_started_at).toBe(armedAt);
          expect(
            yield* f.activities.listIdleArmedTargets({
              deliveredBefore: DateTime.formatIso(yield* DateTime.now),
            }),
          ).toEqual([{ user_id: f.userId, device_id: owner.deviceId }]);
          const aggregate = {
            title: "Synthetic",
            subtitle: "Working",
            activeCount: 0,
            activities: [],
            updatedAt: armedAt,
          };
          yield* f.activities.markDelivery({
            ...owner,
            kind: "live_activity_end",
            aggregate,
            deliveredAt: armedAt,
          });
          yield* TestClock.adjust("1 second");
          const deliveredAt = DateTime.formatIso(yield* DateTime.now);
          yield* f.activities.markDelivery({
            ...owner,
            kind: "live_activity_update",
            aggregate,
            deliveredAt,
          });
          const target = (yield* f.activities.listTargets(owner))[0]!;
          expect(target).toMatchObject({
            activity_push_token: null,
            ended_at: armedAt,
            last_live_activity_delivery_at: deliveredAt,
          });
          expect(yield* decodeJson(target.last_aggregate_json!)).toEqual(aggregate);
          yield* f.activities.register({
            ...input,
            registration: { ...input.registration, activityPushToken: "activity-new" },
          });
          expect((yield* f.activities.listTargets(owner))[0]).toMatchObject({
            remote_started_at: deliveredAt,
            ended_at: null,
            last_aggregate_json: null,
            last_live_activity_delivery_at: null,
          });
          yield* f.activities.invalidateDeliveryToken({
            ...owner,
            kind: "push_notification",
            invalidatedAt: deliveredAt,
          });
          expect((yield* f.activities.listTargets(owner))[0]).toMatchObject({
            push_token: null,
            push_to_start_token: "start-phone-a",
            activity_push_token: "activity-new",
          });
          yield* f.activities.invalidateDeliveryToken({
            ...owner,
            kind: "live_activity_update",
            invalidatedAt: deliveredAt,
          });
          expect((yield* f.activities.listTargets(owner))[0]).toMatchObject({
            activity_push_token: null,
            remote_started_at: null,
            ended_at: deliveredAt,
          });
          expect(
            yield* f.activities.listIdleArmedTargets({ deliveredBefore: deliveredAt }),
          ).toEqual([]);
          yield* f.activities.register({
            ...input,
            registration: {
              deviceId: owner.deviceId,
              activityPushToken: "activity-after-invalidation",
            },
          });
          yield* f.activities.markDelivery({
            ...owner,
            kind: "push_notification",
            aggregate: null,
            deliveredAt,
          });
          expect((yield* f.activities.listTargets(owner))[0]).toMatchObject({
            activity_push_token: null,
            remote_started_at: deliveredAt,
            ended_at: null,
            last_live_activity_delivery_at: deliveredAt,
          });
        }).pipe(Effect.provide(layer)),
    );
  });
}
