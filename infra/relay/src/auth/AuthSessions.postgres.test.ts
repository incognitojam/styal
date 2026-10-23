import * as Cloudflare from "alchemy/Cloudflare";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as Devices from "../agentActivity/Devices.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as RelayDb from "../db.ts";
import {
  relayAuthSessions,
  relayLiveActivities,
  relayMobileDevices,
} from "../persistence/schema.ts";
import * as AuthSessions from "./AuthSessions.ts";
import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";
import * as RelayConfiguration from "../Config.ts";
import type { SignedApnsDeliveryJob } from "../agentActivity/apnsDeliveryJobs.ts";
import { config } from "../test/fixtures.ts";

// Opt in with an isolated Postgres database with all relay migrations applied.
const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
const layerDb = Layer.effect(RelayDb.RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl ?? "postgres://unused") })),
);
const queuedJobs: Array<SignedApnsDeliveryJob> = [];
const queueFailures = new Set<string>();
// Runs inside a queue send, before the job is recorded.
const sendHooks = new Map<string, (job: SignedApnsDeliveryJob) => Effect.Effect<void>>();
const layer = Layer.mergeAll(AuthSessions.layer, Devices.layer, LiveActivities.layer).pipe(
  Layer.provideMerge(ApnsDeliveryQueue.layer),
  Layer.provide(
    Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
      send: (job) =>
        queueFailures.has(job.payload.target.userId)
          ? Effect.fail(new Cloudflare.Queues.SendError({ message: "Synthetic queue outage" }))
          : (sendHooks.get(job.payload.target.userId)?.(job) ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  queuedJobs.push(job);
                }),
              ),
            ),
    }),
  ),
  Layer.provide(RelayConfiguration.layer(config)),
  Layer.provideMerge(layerDb),
  Layer.provideMerge(NodeCrypto.layer),
);

const fixture = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const devices = yield* Devices.Devices;
  const sessions = yield* AuthSessions.AuthSessions;
  const userId = `usr_test_${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      queueFailures.delete(userId);
      sendHooks.delete(userId);
      yield* db.delete(relayLiveActivities).where(eq(relayLiveActivities.userId, userId));
      yield* db.delete(relayMobileDevices).where(eq(relayMobileDevices.userId, userId));
      yield* db.delete(relayAuthSessions).where(eq(relayAuthSessions.userId, userId));
    }).pipe(Effect.orDie),
  );
  const create = (thumbprint: string) =>
    sessions.create({ userId, clientId: "t3-mobile", thumbprint });
  const register = (deviceId: string, sessionId?: string) =>
    Effect.gen(function* () {
      yield* devices.register({
        userId,
        ...(sessionId ? { sessionId } : {}),
        registration: {
          deviceId,
          label: "Test phone",
          platform: "ios",
          iosMajorVersion: 18,
          preferences: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        },
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db.insert(relayLiveActivities).values({
        userId,
        deviceId,
        activityPushToken: `${userId}-${deviceId}`,
        createdAt: now,
        updatedAt: now,
      });
    });
  const remaining = Effect.gen(function* () {
    const registered = yield* devices.listForUser({ userId });
    const activities = yield* db
      .select()
      .from(relayLiveActivities)
      .where(eq(relayLiveActivities.userId, userId));
    return {
      devices: registered.map((row) => row.deviceId).sort(),
      activities: activities.map((row) => row.deviceId).sort(),
    };
  });
  const ends = () =>
    queuedJobs
      .filter((job) => job.payload.target.userId === userId)
      .map((job) => ({
        deviceId: job.payload.target.deviceId,
        kind: job.payload.kind,
        registrationRemoved: job.payload.registrationRemoved,
        token: job.payload.target.token,
      }));
  return { db, devices, sessions, userId, create, register, remaining, ends };
});

describe.skipIf(!databaseUrl)("session-owned mobile delivery (Postgres)", () => {
  it.live("a session is live until it is revoked or expires, and only for its user", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const revoked = yield* f.create("key-a");
      const expired = yield* f.create("key-b");
      const live = (sessionId: string, userId = f.userId) =>
        f.sessions.isLive({ userId, sessionId });
      expect(yield* live(revoked.sessionId)).toBe(true);
      expect(yield* live(revoked.sessionId, "usr_someone_else")).toBe(false);
      yield* f.sessions.revoke({ userId: f.userId, sessionId: revoked.sessionId });
      expect(yield* live(revoked.sessionId)).toBe(false);
      yield* f.db
        .update(relayAuthSessions)
        .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
        .where(eq(relayAuthSessions.sessionId, expired.sessionId));
      expect(yield* live(expired.sessionId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live.each(["revoke", "sign-out", "expiry"])(
    "rolls back %s and retains registration tokens when end enqueue fails",
    (operation) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const session = yield* f.create("key");
        yield* f.register("phone", session.sessionId);
        if (operation === "expiry") {
          yield* f.db
            .update(relayAuthSessions)
            .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
            .where(eq(relayAuthSessions.sessionId, session.sessionId));
        }
        const remove =
          operation === "revoke"
            ? f.sessions
                .revoke({ userId: f.userId, sessionId: session.sessionId })
                .pipe(Effect.asVoid)
            : operation === "sign-out"
              ? f.sessions.revokeByToken({ token: session.token, thumbprint: "key" })
              : f.sessions.pruneExpired;
        queueFailures.add(f.userId);
        expect((yield* Effect.flip(remove))._tag).toBe("AuthSessionPersistenceError");
        expect(yield* f.remaining).toEqual({ devices: ["phone"], activities: ["phone"] });
        expect(
          yield* f.db
            .select()
            .from(relayAuthSessions)
            .where(eq(relayAuthSessions.sessionId, session.sessionId)),
        ).toHaveLength(1);
        queueFailures.delete(f.userId);
        yield* remove;
        expect(yield* f.remaining).toEqual({ devices: [], activities: [] });
        expect(f.ends()).toMatchObject([{ deviceId: "phone", registrationRemoved: true }]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "revocation deletes only the session's devices and activities, retaining legacy registrations",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const owned = yield* f.create("key-a");
        const other = yield* f.create("key-b");
        yield* f.register("owned", owned.sessionId);
        yield* f.register("other", other.sessionId);
        yield* f.register("legacy");
        expect(
          yield* f.sessions.revoke({ userId: "usr_foreign", sessionId: owned.sessionId }),
        ).toBe(false);
        expect((yield* f.remaining).devices).toHaveLength(3);
        expect(yield* f.sessions.revoke({ userId: f.userId, sessionId: owned.sessionId })).toBe(
          true,
        );
        expect(yield* f.remaining).toEqual({
          devices: ["legacy", "other"],
          activities: ["legacy", "other"],
        });
        expect(f.ends()).toMatchObject([
          { deviceId: "owned", kind: "live_activity_end", registrationRemoved: true },
        ]);
        expect(yield* f.sessions.revoke({ userId: f.userId, sessionId: owned.sessionId })).toBe(
          false,
        );
        expect(f.ends()).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("sign-out checks key ownership and removes delivery authorization", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const session = yield* f.create("key");
      yield* f.register("phone", session.sessionId);
      yield* f.register("legacy");
      yield* f.sessions.revokeByToken({ token: session.token, thumbprint: "foreign-key" });
      expect(f.ends()).toEqual([]);
      expect((yield* f.remaining).devices).toHaveLength(2);
      yield* f.sessions.revokeByToken({ token: session.token, thumbprint: "key" });
      expect(yield* f.remaining).toEqual({ devices: ["legacy"], activities: ["legacy"] });
      expect(f.ends()).toMatchObject([{ deviceId: "phone", registrationRemoved: true }]);
      expect(
        Option.isNone(yield* f.sessions.authenticate({ token: session.token, thumbprint: "key" })),
      ).toBe(true);
      const rejected = yield* Effect.flip(f.register("resurrected", session.sessionId));
      expect(rejected._tag).toBe("DeviceSessionRevoked");
      expect(yield* f.remaining).toEqual({ devices: ["legacy"], activities: ["legacy"] });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "pruning an expired session removes its delivery and preserves live and legacy devices",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const expired = yield* f.create("key-expired");
        const live = yield* f.create("key-live");
        yield* f.register("expired", expired.sessionId);
        yield* f.register("live", live.sessionId);
        yield* f.register("legacy");
        yield* f.db
          .update(relayAuthSessions)
          .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
          .where(eq(relayAuthSessions.sessionId, expired.sessionId));
        yield* f.sessions.pruneExpired;
        expect(f.ends()).toMatchObject([{ deviceId: "expired", registrationRemoved: true }]);
        expect(yield* f.remaining).toEqual({
          devices: ["legacy", "live"],
          activities: ["legacy", "live"],
        });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("a Live Activity registration for a revoked session is rejected", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const liveActivities = yield* LiveActivities.LiveActivities;
      const session = yield* f.create("key");
      yield* f.register("phone", session.sessionId);
      const registerActivity = liveActivities.register({
        userId: f.userId,
        sessionId: session.sessionId,
        registration: {
          deviceId: "phone",
          activityPushToken: `${f.userId}-replacement`,
        } as Parameters<typeof liveActivities.register>[0]["registration"],
      });
      yield* registerActivity;
      yield* f.sessions.revokeByToken({ token: session.token, thumbprint: "key" });
      expect(f.ends()).toMatchObject([{ token: `${f.userId}-replacement` }]);
      const rejected = yield* Effect.flip(registerActivity);
      expect(rejected._tag).toBe("DeviceSessionRevoked");
      expect(yield* f.remaining).toEqual({ devices: [], activities: [] });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("queues Live Activity ends without holding the session row lock", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const session = yield* f.create("key");
      yield* f.register("phone", session.sessionId);
      const sending = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Runs before the fixture cleanup, so a failed assertion cannot leave
      // revocation waiting with its row locks held.
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      sendHooks.set(f.userId, () =>
        Deferred.succeed(sending, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const revoke = yield* f.sessions
        .revoke({ userId: f.userId, sessionId: session.sessionId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(sending);
      // NOWAIT fails at once if revocation held the row while sending.
      const locked = yield* f.db.$client.withTransaction(
        f.db.$client`
          select 1 from relay_auth_sessions where session_id = ${session.sessionId} for update nowait
        `,
      );
      expect(locked).toHaveLength(1);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(revoke)).toBe(true);
      expect(yield* f.remaining).toEqual({ devices: [], activities: [] });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("a registration arriving while ends are queued gets its own end before removal", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const session = yield* f.create("key");
      yield* f.register("phone", session.sessionId);
      let registeredLate = false;
      sendHooks.set(f.userId, () =>
        registeredLate
          ? Effect.void
          : Effect.suspend(() => {
              registeredLate = true;
              return f.register("tablet", session.sessionId).pipe(Effect.orDie);
            }),
      );
      yield* f.sessions.revokeByToken({ token: session.token, thumbprint: "key" });
      expect(yield* f.remaining).toEqual({ devices: [], activities: [] });
      expect([...new Set(f.ends().map((end) => end.deviceId))].sort()).toEqual(["phone", "tablet"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("registration racing revocation cannot recreate a revoked device", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const session = yield* f.create("key");
      // Repeat registrations use the same device, as an APNs token callback does.
      const registration = {
        userId: f.userId,
        sessionId: session.sessionId,
        registration: {
          deviceId: "phone",
          label: "Test phone",
          platform: "ios" as const,
          iosMajorVersion: 18,
          preferences: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        },
      };
      yield* Effect.all(
        [
          f.devices.register(registration).pipe(Effect.result),
          f.sessions.revoke({ userId: f.userId, sessionId: session.sessionId }),
        ],
        { concurrency: "unbounded" },
      );
      expect(yield* f.remaining).toEqual({ devices: [], activities: [] });
      const persisted = yield* f.db
        .select()
        .from(relayAuthSessions)
        .where(eq(relayAuthSessions.sessionId, session.sessionId));
      expect(persisted).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
