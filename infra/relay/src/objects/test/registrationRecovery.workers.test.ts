import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { identityLayer } from "../IdentityPersistence.ts";
import { RegistrationCoordinator } from "../RegistrationCoordinator.ts";
import { registrationLayer } from "../RegistrationPersistence.ts";
import { accountName, pushTokenName, inventoryShardName } from "../names.ts";
import { RPC_VERSION as version } from "../storage.ts";
import { AccountPersistence, SessionPersistence } from "../../persistence/IdentityPersistence.ts";
import {
  DevicePersistence,
  LiveActivityPersistence,
} from "../../persistence/RegistrationPersistence.ts";
import {
  ApnsDeliveryQueue,
  ApnsDeliveryQueueSendError,
} from "../../agentActivity/ApnsDeliveryQueue.ts";
import * as Config from "../../Config.ts";
import { config } from "../../test/fixtures.ts";
import { disabledRegistrationCleanup } from "./registrationFixtures.ts";
import { resetRegistrationObjects, namespaceWith } from "./resetRegistrationObjects.ts";
const options = { emailKey: new Uint8Array(32).fill(1), signInCodeSecret: "synthetic-code-secret" };
const registration = (
  deviceId: string,
  pushToken = "shared-push",
): RelayDeviceRegistrationRequest => ({
  deviceId,
  label: "Synthetic phone",
  platform: "ios",
  pushToken,
  pushToStartToken: `start-${deviceId}`,
  bundleId: "test.example.phone",
  apsEnvironment: "sandbox",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
    attendedAlertDelaySeconds: 90,
  },
});
it.effect.each([
  { operation: "revoke", pending: false },
  { operation: "prune", pending: false },
  { operation: "revoke", pending: true },
  { operation: "prune", pending: true },
] as const)(
  "retains cleanup work during an activity-token outage: %o",
  ({ operation, pending }) => {
    let unavailable = false;
    let loseFinish = false;
    let rejectEnd = false;
    const ends: string[] = [];
    const bindings = {
      ...env,
      ACCOUNTS: namespaceWith(env.ACCOUNTS, (name: string) => {
        const stub = env.ACCOUNTS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "registrations")
              return async (request: Parameters<typeof stub.registrations>[0]) => {
                if (loseFinish && request.command.kind === "finish") {
                  loseFinish = false;
                  throw new Error("Synthetic interruption before activity completion");
                }
                return stub.registrations(request);
              };
            return Reflect.get(target, method, target);
          },
        });
      }),
      PUSH_TOKENS: {
        getByName(name: string) {
          if (unavailable && name === pushTokenName("live-activity", "outage-card"))
            throw new Error("Synthetic activity token outage");
          return env.PUSH_TOKENS.getByName(name);
        },
      },
    };
    const queue = Layer.succeed(
      ApnsDeliveryQueue,
      ApnsDeliveryQueue.of({
        enqueueLiveActivity: (input) =>
          Effect.gen(function* () {
            ends.push(input.token);
            if (rejectEnd) {
              rejectEnd = false;
              return yield* new ApnsDeliveryQueueSendError({
                operation: "send",
                jobId: "synthetic-end-job",
                kind: input.kind,
                userId: input.userId,
                deviceId: input.deviceId,
                cause: "synthetic queue outage",
              });
            }
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
        enqueuePushNotification: () => Effect.die("Unexpected notification"),
      }),
    );
    const layer = Layer.mergeAll(
      identityLayer(bindings, options),
      registrationLayer(bindings),
    ).pipe(Layer.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, Config.layer(config), queue)));
    return Effect.gen(function* () {
      yield* Effect.promise(resetRegistrationObjects);
      const accounts = yield* AccountPersistence;
      const sessions = yield* SessionPersistence;
      const devices = yield* DevicePersistence;
      const activities = yield* LiveActivityPersistence;
      const userId = (yield* accounts.findOrCreateByEmail("outage@example.test")).userId;
      const session = yield* sessions.create({
        userId,
        clientId: "t3-mobile",
        thumbprint: "key-a",
      });
      yield* devices.register({
        userId,
        sessionId: session.sessionId,
        registration: registration("outage-phone"),
      });
      loseFinish = pending;
      const arm = activities.register({
        userId,
        sessionId: session.sessionId,
        registration: { deviceId: "outage-phone", activityPushToken: "outage-card" },
      });
      if (pending) {
        expect(yield* arm.pipe(Effect.flip)).toMatchObject({
          _tag: "LiveActivityRegistrationPersistenceError",
        });
        yield* Effect.promise(abortAllDurableObjects);
      } else yield* arm;
      if (operation === "prune") yield* TestClock.adjust("90 days");
      unavailable = true;
      const remove =
        operation === "revoke"
          ? sessions.revoke({ userId, sessionId: session.sessionId })
          : sessions.pruneExpired;
      expect(yield* remove.pipe(Effect.flip)).toMatchObject({
        _tag: "AuthSessionPersistenceError",
      });
      expect(yield* devices.listForUser({ userId })).toHaveLength(1);
      expect(
        yield* Effect.promise(async () =>
          env.ACCOUNTS.getByName(accountName(userId)).identity({
            version,
            userId,
            command: { kind: "session", sessionId: session.sessionId },
          }),
        ),
      ).toMatchObject({ session: { revoked: false } });
      expect(ends).toEqual([]);
      unavailable = false;
      if (pending && operation === "prune") {
        rejectEnd = true;
        expect(yield* remove.pipe(Effect.flip)).toMatchObject({
          _tag: "AuthSessionPersistenceError",
        });
        yield* Effect.promise(abortAllDurableObjects);
        const targets = yield* Effect.promise(() =>
          new RegistrationCoordinator(env).cleanup(
            { kind: "session", userId, sessionId: session.sessionId },
            "1970-01-01T00:00:00.000Z",
          ),
        );
        expect(targets.map((target) => target.token)).toEqual(["outage-card"]);
      }
      yield* remove;
      expect(ends).toEqual(
        pending && operation === "prune" ? ["outage-card", "outage-card"] : ["outage-card"],
      );
      expect(yield* devices.listForUser({ userId })).toEqual([]);
      expect(
        (yield* Effect.promise(() =>
          new RegistrationCoordinator(env).snapshot(userId, "1970-01-01T00:00:00.000Z"),
        )).ends,
      ).toEqual([]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["before-remove", "after-remove", "raw-remove"] as const)(
  "resumes session cleanup across restart %s",
  (phase) => {
    const ends: string[] = [];
    let interrupt = true;
    const bindings = {
      ...env,
      ACCOUNTS: namespaceWith(env.ACCOUNTS, (name: string) => {
        const stub = env.ACCOUNTS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "identity")
              return async (request: Parameters<typeof stub.identity>[0]) => {
                if (request.command.kind !== "revoke-session" || !interrupt)
                  return stub.identity(request);
                interrupt = false;
                if (phase === "after-remove") await stub.identity(request);
                await abortAllDurableObjects();
                throw new Error("Synthetic interrupted session cleanup");
              };
            return Reflect.get(target, method, target);
          },
        });
      }),
    };
    const queue = Layer.succeed(
      ApnsDeliveryQueue,
      ApnsDeliveryQueue.of({
        enqueueLiveActivity: (input) =>
          Effect.sync(() => {
            ends.push(input.token);
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
        enqueuePushNotification: () => Effect.die("Unexpected notification"),
      }),
    );
    const layer = Layer.mergeAll(
      identityLayer(bindings, options),
      registrationLayer(bindings),
    ).pipe(Layer.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, Config.layer(config), queue)));
    return Effect.gen(function* () {
      yield* Effect.promise(resetRegistrationObjects);
      const account = yield* AccountPersistence;
      const sessions = yield* SessionPersistence;
      const devices = yield* DevicePersistence;
      const activities = yield* LiveActivityPersistence;
      const userId = (yield* account.findOrCreateByEmail("cleanup@example.test")).userId;
      const session = yield* sessions.create({
        userId,
        clientId: "t3-mobile",
        thumbprint: "session-key",
      });
      yield* devices.register({
        userId,
        sessionId: session.sessionId,
        registration: registration("phone-a"),
      });
      yield* activities.register({
        userId,
        sessionId: session.sessionId,
        registration: { deviceId: "phone-a", activityPushToken: "card-a" },
      });
      if (phase === "raw-remove") {
        yield* Effect.promise(async () =>
          env.ACCOUNTS.getByName(accountName(userId)).identity({
            version,
            userId,
            command: { kind: "revoke-session", sessionId: session.sessionId },
          }),
        );
        yield* Effect.promise(abortAllDurableObjects);
        interrupt = false;
      } else {
        expect(
          yield* sessions.revoke({ userId, sessionId: session.sessionId }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "AuthSessionPersistenceError" });
      }
      expect(yield* sessions.isLive({ userId, sessionId: session.sessionId })).toBe(
        phase === "before-remove",
      );
      expect(yield* sessions.revoke({ userId, sessionId: session.sessionId })).toBe(
        phase === "before-remove",
      );
      expect(ends).toEqual(phase === "before-remove" ? ["card-a", "card-a"] : ["card-a"]);
      expect(yield* devices.listForUser({ userId })).toEqual([]);
      expect(yield* activities.listTargets({ userId })).toEqual([]);
      yield* Effect.promise(async () => {
        for (const [kind, token] of [
          ["push", "shared-push"],
          ["push-to-start", "start-phone-a"],
          ["live-activity", "card-a"],
        ] as const) {
          const name = pushTokenName(kind, token);
          expect(
            await runInDurableObject(env.PUSH_TOKENS.getByName(name), (_instance, ctx) =>
              ctx.storage.sql
                .exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
                .toArray(),
            ),
          ).toEqual([]);
          expect(
            await env.INVENTORY.getByName(inventoryShardName("push-token", name)).list({
              version,
              kind: "push-token",
              after: "",
              limit: 1000,
            }),
          ).not.toContainEqual({ name });
        }
        const stored = await runInDurableObject(
          env.ACCOUNTS.getByName(accountName(userId)),
          (_instance, ctx) => ({
            refs: ctx.storage.sql.exec("SELECT * FROM registration_token_references").toArray(),
            retirements: ctx.storage.sql.exec("SELECT * FROM registration_retirements").toArray(),
            ends: ctx.storage.sql.exec("SELECT * FROM registration_ends").toArray(),
            outcomes: ctx.storage.sql.exec("SELECT * FROM registration_outcomes").toArray(),
          }),
        );
        expect(stored.refs).toEqual([]);
        expect(stored.retirements).toEqual([]);
        expect(stored.ends).toEqual([]);
        expect(JSON.stringify(stored)).not.toContain("shared-push");
        expect(JSON.stringify(stored)).not.toContain("card-a");
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["mark", "invalidate"] as const)(
  "uses the current authorization clock for a delayed %s callback",
  (callback) => {
    let loseReady = false;
    const bindings = {
      ...env,
      ACCOUNTS: namespaceWith(env.ACCOUNTS, (name: string) => {
        const stub = env.ACCOUNTS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "registrations")
              return async (request: Parameters<typeof stub.registrations>[0]) => {
                const result = await stub.registrations(request);
                if (loseReady && request.command.kind === "ready") {
                  loseReady = false;
                  throw new Error("Synthetic lost prepared registration response");
                }
                return result;
              };
            return Reflect.get(target, method, target);
          },
        });
      }),
    };
    const layer = Layer.mergeAll(
      identityLayer(bindings, options),
      registrationLayer(bindings),
    ).pipe(Layer.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, disabledRegistrationCleanup)));
    return Effect.gen(function* () {
      yield* Effect.promise(resetRegistrationObjects);
      const accounts = yield* AccountPersistence;
      const sessions = yield* SessionPersistence;
      const devices = yield* DevicePersistence;
      const activities = yield* LiveActivityPersistence;
      const userId = (yield* accounts.findOrCreateByEmail("delayed-callback@example.test")).userId;
      const session = yield* sessions.create({
        userId,
        clientId: "t3-mobile",
        thumbprint: "delayed-key",
      });
      yield* devices.register({
        userId: "working-account",
        registration: registration("working-phone"),
      });
      loseReady = true;
      expect(
        yield* devices
          .register({
            userId,
            sessionId: session.sessionId,
            registration: registration("pending-phone"),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "DeviceRegistrationPersistenceError" });
      const coordinator = new RegistrationCoordinator(env);
      const pending = (yield* Effect.promise(() =>
        coordinator.snapshot(userId, "1970-01-01T00:00:00.000Z"),
      )).records[0]!.pending!;
      const callbackAt = DateTime.formatIso(yield* DateTime.now);
      yield* TestClock.adjust("90 days");
      yield* Effect.promise(abortAllDurableObjects);
      if (callback === "mark")
        yield* activities.markDelivery({
          userId,
          deviceId: "pending-phone",
          kind: "push_notification",
          aggregate: null,
          deliveredAt: callbackAt,
        });
      else
        yield* activities.invalidateDeliveryToken({
          userId,
          deviceId: "pending-phone",
          kind: "push_notification",
          invalidatedAt: callbackAt,
        });
      expect((yield* activities.listTargets({ userId: "working-account" }))[0]?.push_token).toBe(
        "shared-push",
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      expect(
        yield* Effect.promise(() =>
          coordinator.command(userId, {
            kind: "check",
            deviceId: "pending-phone",
            id: pending.id,
            now,
          }),
        ),
      ).toMatchObject({ status: "cancelled", reason: "session-revoked" });
      if (callback === "mark")
        expect(
          (yield* Effect.promise(() => coordinator.snapshot(userId, now))).records[0]?.active
            .activity?.deliveredAt,
        ).toBe(callbackAt);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { operation: "revoke", markKind: "live_activity_update" },
  { operation: "prune", markKind: "live_activity_update" },
  { operation: "revoke", markKind: "live_activity_end" },
  { operation: "prune", markKind: "live_activity_end" },
] as const)(
  "removes a session while every queued end interleaves a delivery mark: %o",
  ({ operation, markKind }) => {
    let activities: LiveActivityPersistence["Service"] | undefined;
    let sent = 0;
    const queue = Layer.succeed(
      ApnsDeliveryQueue,
      ApnsDeliveryQueue.of({
        enqueueLiveActivity: (input) =>
          Effect.suspend(() => {
            const current = activities;
            if (!current) return Effect.die("Synthetic fixture not initialized");
            sent++;
            return current
              .markDelivery({
                userId: input.userId,
                deviceId: input.deviceId,
                kind: markKind,
                aggregate: null,
                deliveredAt: DateTime.formatIso(DateTime.makeUnsafe(sent * 1000)),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ApnsDeliveryQueueSendError({
                      operation: "send",
                      jobId: "synthetic-mark-race",
                      kind: input.kind,
                      userId: input.userId,
                      deviceId: input.deviceId,
                      cause,
                    }),
                ),
                Effect.as({
                  deviceId: input.deviceId,
                  kind: input.kind,
                  ok: true,
                  queued: true,
                  apnsStatus: null,
                  apnsReason: null,
                  apnsId: null,
                }),
              );
          }),
        enqueuePushNotification: () => Effect.die("Unexpected notification"),
      }),
    );
    const layer = Layer.mergeAll(identityLayer(env, options), registrationLayer(env)).pipe(
      Layer.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, Config.layer(config), queue)),
    );
    return Effect.gen(function* () {
      yield* Effect.promise(resetRegistrationObjects);
      const accounts = yield* AccountPersistence;
      const sessions = yield* SessionPersistence;
      const devices = yield* DevicePersistence;
      activities = yield* LiveActivityPersistence;
      const userId = (yield* accounts.findOrCreateByEmail("mark-race@example.test")).userId;
      const session = yield* sessions.create({
        userId,
        clientId: "t3-mobile",
        thumbprint: "mark-race-key",
      });
      yield* devices.register({
        userId,
        sessionId: session.sessionId,
        registration: registration("mark-race-phone"),
      });
      yield* activities.register({
        userId,
        sessionId: session.sessionId,
        registration: { deviceId: "mark-race-phone", activityPushToken: "mark-race-card" },
      });
      if (operation === "prune") yield* TestClock.adjust("90 days");
      if (operation === "revoke")
        expect(yield* sessions.revoke({ userId, sessionId: session.sessionId })).toBe(true);
      else yield* sessions.pruneExpired;
      expect(sent).toBe(1);
      expect(yield* devices.listForUser({ userId })).toEqual([]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "reports unavailable token status as typed failure without replacing the working activity",
  () => {
    let unavailable = false;
    const bindings = {
      ...env,
      PUSH_TOKENS: namespaceWith(env.PUSH_TOKENS, (name: string) => {
        if (unavailable && name === pushTokenName("live-activity", "working-card"))
          throw new Error("Synthetic token status outage");
        return env.PUSH_TOKENS.getByName(name);
      }),
    };
    return Effect.gen(function* () {
      yield* Effect.promise(resetRegistrationObjects);
      const devices = yield* DevicePersistence;
      const activities = yield* LiveActivityPersistence;
      yield* devices.register({ userId: "account-a", registration: registration("phone-a") });
      yield* activities.register({
        userId: "account-a",
        registration: { deviceId: "phone-a", activityPushToken: "working-card" },
      });
      unavailable = true;
      expect(
        yield* activities.listTargets({ userId: "account-a" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "LiveActivityTargetListPersistenceError" });
      expect(
        yield* activities
          .register({
            userId: "account-a",
            registration: { deviceId: "phone-a", activityPushToken: "replacement-card" },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "LiveActivityRegistrationPersistenceError" });
      expect(yield* devices.listForUser({ userId: "account-a" })).toHaveLength(1);
      unavailable = false;
      expect((yield* activities.listTargets({ userId: "account-a" }))[0]?.activity_push_token).toBe(
        "working-card",
      );
      expect(
        yield* Effect.promise(async () =>
          env.PUSH_TOKENS.getByName(pushTokenName("live-activity", "replacement-card")).read({
            version,
          }),
        ),
      ).toMatchObject({ initialized: false });
    }).pipe(
      Effect.provide(registrationLayer(bindings).pipe(Layer.provide(SecureRandom.layerWebCrypto))),
    );
  },
);

it.effect.each(["owner", "activity"] as const)(
  "continues idle maintenance when one account's %s call fails",
  (failure) => {
    let unavailable = false;
    const bindings = {
      ...env,
      ACCOUNTS: namespaceWith(env.ACCOUNTS, (name: string) => {
        const stub = env.ACCOUNTS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (
              method === "identityOwner" &&
              failure === "owner" &&
              name === accountName("idle-broken")
            )
              return (...request: Parameters<typeof stub.identityOwner>) => {
                if (unavailable) throw new Error("Synthetic account outage");
                return stub.identityOwner(...request);
              };
            return Reflect.get(target, method, target);
          },
        });
      }),
      PUSH_TOKENS: namespaceWith(env.PUSH_TOKENS, (name: string) => {
        if (
          unavailable &&
          failure === "activity" &&
          name === pushTokenName("live-activity", "card-idle-broken")
        )
          throw new Error("Synthetic activity outage");
        return env.PUSH_TOKENS.getByName(name);
      }),
    };
    return Effect.gen(function* () {
      yield* Effect.promise(resetRegistrationObjects);
      const devices = yield* DevicePersistence;
      const activities = yield* LiveActivityPersistence;
      for (const userId of ["idle-broken", "idle-healthy"]) {
        yield* devices.register({ userId, registration: registration(userId, `push-${userId}`) });
        yield* activities.register({
          userId,
          registration: { deviceId: userId, activityPushToken: `card-${userId}` },
        });
      }
      yield* TestClock.adjust("10 minutes");
      unavailable = true;
      expect(
        yield* activities.listIdleArmedTargets({ deliveredBefore: "1970-01-01T00:05:00.000Z" }),
      ).toEqual([{ user_id: "idle-healthy", device_id: "idle-healthy" }]);
    }).pipe(
      Effect.provide(registrationLayer(bindings).pipe(Layer.provide(SecureRandom.layerWebCrypto))),
    );
  },
);
