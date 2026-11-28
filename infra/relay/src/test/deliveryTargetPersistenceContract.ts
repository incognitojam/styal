import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  DevicePersistence,
  LiveActivityPersistence,
} from "../persistence/RegistrationPersistence.ts";
import { AccountPersistence, SessionPersistence } from "../persistence/IdentityPersistence.ts";
import {
  FcmTokenPersistence,
  RegistrationCleanupPersistence,
} from "../persistence/DeliveryTargetPersistence.ts";

type Ports =
  | DevicePersistence
  | LiveActivityPersistence
  | AccountPersistence
  | SessionPersistence
  | FcmTokenPersistence
  | RegistrationCleanupPersistence;

const registration = (deviceId: string) => ({
  deviceId,
  label: "Synthetic phone",
  platform: "ios" as const,
  iosMajorVersion: 18,
  bundleId: "test.example.phone",
  apsEnvironment: "sandbox" as const,
  pushToken: `push-${deviceId}`,
  pushToStartToken: `start-${deviceId}`,
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
});

export function deliveryTargetPersistenceContract<E>(name: string, layer: Layer.Layer<Ports, E>) {
  describe(name, () => {
    it.effect(
      "invalidates only the exact current push token without changing timestamps or other token domains",
      () =>
        Effect.gen(function* () {
          const devices = yield* DevicePersistence;
          const activities = yield* LiveActivityPersistence;
          const tokens = yield* FcmTokenPersistence;
          const owner = { userId: "account-a", deviceId: "phone-a" };
          yield* devices.register({
            userId: owner.userId,
            registration: registration(owner.deviceId),
          });
          yield* activities.register({
            userId: owner.userId,
            registration: { deviceId: owner.deviceId, activityPushToken: "activity-a" },
          });
          yield* TestClock.adjust("1 second");
          yield* devices.register({
            userId: owner.userId,
            registration: { ...registration(owner.deviceId), pushToken: "replacement" },
          });
          const updatedAt = (yield* devices.listForUser(owner))[0]!.updatedAt;
          yield* TestClock.adjust("1 second");
          yield* tokens.invalidate({ ...owner, token: "push-phone-a" });
          yield* tokens.invalidate({ ...owner, userId: "account-b", token: "replacement" });
          yield* tokens.invalidate({ ...owner, deviceId: "phone-b", token: "replacement" });
          expect((yield* activities.listTargets(owner))[0]?.push_token).toBe("replacement");
          yield* tokens.invalidate({ ...owner, token: "replacement" });
          yield* tokens.invalidate({ ...owner, token: "replacement" });
          expect((yield* activities.listTargets(owner))[0]).toMatchObject({
            push_token: null,
            push_to_start_token: "start-phone-a",
            activity_push_token: "activity-a",
          });
          expect((yield* devices.listForUser(owner))[0]?.updatedAt).toBe(updatedAt);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "routes cleanup by account or session and joins activity tokens to the exact device owner",
      () =>
        Effect.gen(function* () {
          const devices = yield* DevicePersistence;
          const activities = yield* LiveActivityPersistence;
          const accounts = yield* AccountPersistence;
          const sessions = yield* SessionPersistence;
          const cleanup = yield* RegistrationCleanupPersistence;
          const userId = (yield* accounts.findOrCreateByEmail("phone@example.test")).userId;
          const otherUserId = (yield* accounts.findOrCreateByEmail("other@example.test")).userId;
          const session = yield* sessions.create({
            userId,
            clientId: "t3-mobile",
            thumbprint: "key-a",
          });
          yield* devices.register({
            userId,
            sessionId: session.sessionId,
            registration: registration("phone-a"),
          });
          yield* devices.register({ userId, registration: registration("legacy") });
          yield* devices.register({ userId, registration: registration("unarmed") });
          yield* devices.register({
            userId: otherUserId,
            registration: {
              ...registration("phone-a"),
              pushToken: "other-push",
              pushToStartToken: "other-start",
            },
          });
          for (const [account, deviceId, token] of [
            [userId, "phone-a", "activity-a"],
            [userId, "legacy", "activity-legacy"],
            [otherUserId, "phone-a", "activity-other"],
            [userId, "orphan", "activity-orphan"],
          ] as const)
            yield* activities.register({
              userId: account,
              registration: { deviceId, activityPushToken: token },
            });
          yield* activities.register({
            userId,
            registration: { deviceId: "unarmed", activityPushToken: "activity-cleared" },
          });
          yield* activities.invalidateDeliveryToken({
            userId,
            deviceId: "unarmed",
            kind: "live_activity_update",
            invalidatedAt: "1970-01-01T00:00:00.000Z",
          });
          const phone = {
            userId,
            deviceId: "phone-a",
            token: "activity-a",
            bundleId: "test.example.phone",
            apsEnvironment: "sandbox",
          };
          const legacy = { ...phone, deviceId: "legacy", token: "activity-legacy" };
          expect(
            (yield* cleanup.listTargets({ kind: "account", userId })).toSorted((a, b) =>
              a.deviceId.localeCompare(b.deviceId),
            ),
          ).toEqual([legacy, phone]);
          expect(
            yield* cleanup.listTargets({ kind: "session", userId, sessionId: session.sessionId }),
          ).toEqual([phone]);
          expect(
            yield* cleanup.listTargets({
              kind: "session",
              userId: otherUserId,
              sessionId: session.sessionId,
            }),
          ).toEqual([]);
          expect(
            yield* cleanup.listTargets({
              kind: "sessions",
              sessionIds: [session.sessionId, "absent"],
            }),
          ).toEqual([phone]);
          expect(yield* cleanup.listTargets({ kind: "sessions", sessionIds: [] })).toEqual([]);
          expect(yield* cleanup.listTargets({ kind: "account", userId: otherUserId })).toEqual([
            { ...phone, userId: otherUserId, token: "activity-other" },
          ]);
          yield* TestClock.adjust("90 days");
          expect(
            (yield* activities.listTargets({ userId })).map((t) => t.device_id).toSorted(),
          ).toEqual(["legacy", "unarmed"]);
          expect(
            yield* cleanup.listTargets({ kind: "session", userId, sessionId: session.sessionId }),
          ).toEqual([phone]);
          yield* devices.unregister({ userId, deviceId: "phone-a" });
          expect(
            yield* cleanup.listTargets({ kind: "session", userId, sessionId: session.sessionId }),
          ).toEqual([]);
        }).pipe(Effect.provide(layer)),
    );
  });
}
