import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  AgentActivityPersistence,
  EnvironmentCredentialPersistence,
  EnvironmentLinkPersistence,
} from "../persistence/EnvironmentPersistence.ts";

const environmentId = EnvironmentId.make("environment-a");
const key = { environmentId, environmentPublicKey: "key-a" };
const endpoint = {
  httpBaseUrl: "https://endpoint.example.test/",
  wsBaseUrl: "wss://endpoint.example.test/",
  providerKind: "cloudflare_tunnel" as const,
};
const linkInput = (userId: string, environmentPublicKey = key.environmentPublicKey) => ({
  userId,
  request: {
    proof: "already-verified-by-linker",
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    managedTunnelsEnabled: true,
  },
  proof: {
    iss: "t3-env:environment-a",
    aud: "https://relay.example.test",
    sub: environmentId,
    jti: `proof-${userId}`,
    iat: 0,
    exp: 300,
    challenge: "already-verified-challenge",
    ...key,
    environmentPublicKey,
    descriptor: {
      environmentId,
      label: "Synthetic environment",
      platform: { os: "linux", arch: "x64" } as const,
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    endpoint,
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 3000 },
    scopes: ["agent_activity_notifications", "managed_tunnels"] as const,
  },
  endpoint,
});
const activity = (phase: RelayAgentActivityState["phase"], updatedAt: string) => ({
  environmentId,
  threadId: ThreadId.make("thread-a"),
  projectTitle: "Synthetic project",
  threadTitle: "Synthetic thread",
  modelTitle: "Synthetic model",
  phase,
  headline: "Synthetic activity",
  updatedAt,
  deepLink: "/threads/environment-a/thread-a",
});

export function environmentLinkContract<E>(
  name: string,
  layer: Layer.Layer<EnvironmentLinkPersistence, E>,
) {
  describe(name, () => {
    it.effect("isolates accounts, preserves original link time on relink, and revokes once", () =>
      Effect.gen(function* () {
        const links = yield* EnvironmentLinkPersistence;
        const owner = { userId: "user-a", environmentId };
        expect(yield* links.getForUser(owner)).toBeNull();
        expect(yield* links.listForUser(owner)).toEqual([]);
        yield* links.upsert(linkInput(owner.userId));
        const original = yield* links.getForUser(owner);
        expect(original).toEqual({
          environmentId,
          label: "Synthetic environment",
          endpoint,
          environmentPublicKey: key.environmentPublicKey,
          linkedAt: DateTime.formatIso(yield* DateTime.now),
        });
        expect(yield* links.listForUser(owner)).toEqual([
          {
            environmentId,
            label: "Synthetic environment",
            endpoint,
            linkedAt: original?.linkedAt,
          },
        ]);
        yield* TestClock.adjust("1 second");
        const changed = linkInput(owner.userId, "key-b");
        yield* links.upsert({
          ...changed,
          proof: { ...changed.proof, descriptor: { ...changed.proof.descriptor, label: " " } },
          endpoint: { ...endpoint, providerKind: "manual" },
        });
        expect(yield* links.getForUser(owner)).toEqual({
          ...original,
          environmentPublicKey: "key-b",
          label: environmentId,
          endpoint: { ...endpoint, providerKind: "manual" },
        });
        expect(yield* links.findActiveManagedForEnvironment({ environmentId })).toEqual([]);
        expect(yield* links.getForUser({ ...owner, userId: "user-b" })).toBeNull();
        expect(yield* links.revokeForUser({ ...owner, userId: "user-b" })).toBe(false);
        expect(yield* links.revokeForUser(owner)).toBe(true);
        expect(yield* links.revokeForUser(owner)).toBe(false);
        expect(yield* links.getForUser(owner)).toBeNull();
        expect(yield* links.listForUser(owner)).toEqual([]);
        yield* links.upsert(linkInput(owner.userId));
        expect((yield* links.getForUser(owner))?.linkedAt).toBe(original?.linkedAt);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "shares a machine by exact key and carries hold opt-in only between live same-key links",
      () =>
        Effect.gen(function* () {
          const links = yield* EnvironmentLinkPersistence;
          yield* Effect.all(
            [links.upsert(linkInput("user-a")), links.upsert(linkInput("user-b"))],
            {
              concurrency: "unbounded",
            },
          );
          yield* links.setHoldWebhooksWhileOffline({ ...key, holdWebhooksWhileOffline: true });
          yield* links.upsert(linkInput("user-c"));
          yield* links.upsert(linkInput("user-d", "key-b"));
          const managed = yield* links.findActiveManagedForEnvironment({ ...key });
          expect(managed.map((row) => row.userId).toSorted()).toEqual([
            "user-a",
            "user-b",
            "user-c",
          ]);
          expect(managed.every((row) => row.holdWebhooksWhileOffline)).toBe(true);
          expect(
            (yield* links.findActiveManagedForEnvironment({ environmentId, userId: "user-d" }))[0]
              ?.holdWebhooksWhileOffline,
          ).toBe(false);
          expect(
            yield* links.findActiveManagedForEnvironment({ ...key, userId: "user-d" }),
          ).toEqual([]);
          expect(
            (yield* links.listDeliveryUsersForEnvironment(key)).map((row) => row.userId).toSorted(),
          ).toEqual(["user-a", "user-b", "user-c"]);
          yield* links.revokeForUser({ userId: "user-a", environmentId });
          expect(
            (yield* links.listDeliveryUsersForEnvironment(key)).map((row) => row.userId).toSorted(),
          ).toEqual(["user-b", "user-c"]);
          yield* links.setHoldWebhooksWhileOffline({ ...key, holdWebhooksWhileOffline: false });
          expect(
            (yield* links.findActiveManagedForEnvironment(key)).every(
              (row) => !row.holdWebhooksWhileOffline,
            ),
          ).toBe(true);
          const quiet = linkInput("user-b");
          yield* links.upsert({
            ...quiet,
            request: {
              ...quiet.request,
              notificationsEnabled: false,
              liveActivitiesEnabled: false,
            },
          });
          expect(
            (yield* links.listDeliveryUsersForEnvironment(key)).map((row) => row.userId),
          ).toEqual(["user-c"]);
        }).pipe(Effect.provide(layer)),
    );
  });
}

export function environmentCredentialContract<E>(
  name: string,
  layer: Layer.Layer<EnvironmentLinkPersistence | EnvironmentCredentialPersistence, E>,
) {
  describe(name, () => {
    it.effect(
      "requires a live exact-key owner and preserves a shared credential until the last owner leaves",
      () =>
        Effect.gen(function* () {
          const links = yield* EnvironmentLinkPersistence;
          const credentials = yield* EnvironmentCredentialPersistence;
          const token = yield* credentials.create(key);
          expect(token).toMatch(/^t3env_[0-9a-f]{64}_[0-9a-f]{96}$/);
          expect(yield* credentials.authenticate(token)).toEqual(Option.none());
          yield* links.upsert(linkInput("user-a"));
          yield* links.upsert(linkInput("user-b"));
          const principal = Option.getOrThrow(yield* credentials.authenticate(token));
          expect(principal).toMatchObject(key);
          expect(yield* credentials.authenticate("malformed")).toEqual(Option.none());
          expect(yield* credentials.authenticate(`${token}changed`)).toEqual(Option.none());
          yield* links.revokeForUser({ userId: "user-a", environmentId });
          expect(yield* credentials.revokeForEnvironmentPublicKey(key)).toBe(false);
          expect(yield* credentials.authenticate(token)).toEqual(Option.some(principal));
          yield* links.revokeForUser({ userId: "user-b", environmentId });
          expect(yield* credentials.authenticate(token)).toEqual(Option.none());
          expect(yield* credentials.revokeForEnvironmentPublicKey(key)).toBe(true);
          expect(yield* credentials.revokeForEnvironmentPublicKey(key)).toBe(false);
          yield* links.upsert(linkInput("user-a"));
          expect(yield* credentials.authenticate(token)).toEqual(Option.none());
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "rotates only the same key and denies an old key after the last matching link changes",
      () =>
        Effect.gen(function* () {
          const links = yield* EnvironmentLinkPersistence;
          const credentials = yield* EnvironmentCredentialPersistence;
          yield* links.upsert(linkInput("user-a"));
          const old = yield* credentials.create(key);
          const current = yield* credentials.create(key);
          expect(yield* credentials.authenticate(old)).toEqual(Option.none());
          expect(Option.isSome(yield* credentials.authenticate(current))).toBe(true);
          yield* links.upsert(linkInput("user-b", "key-b"));
          const other = yield* credentials.create({ ...key, environmentPublicKey: "key-b" });
          expect(Option.isSome(yield* credentials.authenticate(current))).toBe(true);
          expect(Option.isSome(yield* credentials.authenticate(other))).toBe(true);
          yield* links.upsert(linkInput("user-a", "key-b"));
          expect(yield* credentials.authenticate(current)).toEqual(Option.none());
          expect(Option.isSome(yield* credentials.authenticate(other))).toBe(true);
          expect(yield* credentials.revokeForEnvironmentPublicKey(key)).toBe(true);
          expect(Option.isSome(yield* credentials.authenticate(other))).toBe(true);
        }).pipe(Effect.provide(layer)),
    );
  });
}

export function agentActivityContract<E>(
  name: string,
  layer: Layer.Layer<EnvironmentLinkPersistence | AgentActivityPersistence, E>,
) {
  describe(name, () => {
    it.effect(
      "partitions activity by key, gates lists by preferences, and keeps shared rows after one owner leaves",
      () =>
        Effect.gen(function* () {
          const links = yield* EnvironmentLinkPersistence;
          const rows = yield* AgentActivityPersistence;
          const state = activity("running", "2026-01-01T00:00:00.000Z");
          expect(yield* rows.upsert({ environmentPublicKey: "key-a", state })).toBeNull();
          yield* links.upsert(linkInput("user-a"));
          yield* links.upsert(linkInput("user-b"));
          yield* links.upsert(linkInput("user-c", "key-b"));
          expect(yield* rows.listForUser({ userId: "user-a" })).toEqual([state]);
          expect(yield* rows.listForUser({ userId: "user-c" })).toEqual([]);
          const waiting = { ...state, phase: "waiting_for_input" as const };
          expect(yield* rows.upsert({ environmentPublicKey: "key-b", state: waiting })).toBeNull();
          const next = { ...state, headline: "Updated", updatedAt: "2026-01-02T00:00:00.000Z" };
          expect(yield* rows.upsert({ environmentPublicKey: "key-a", state: next })).toEqual(state);
          expect(yield* rows.upsert({ environmentPublicKey: "key-a", state })).toEqual(next);
          expect(
            yield* rows.getForUserThread({
              userId: "user-a",
              environmentId,
              threadId: state.threadId,
            }),
          ).toEqual(state);
          yield* rows.upsert({ environmentPublicKey: "key-a", state: next });
          yield* rows.remove({ ...key, environmentPublicKey: "wrong", threadId: state.threadId });
          const thread = { userId: "user-a", environmentId, threadId: state.threadId };
          expect(yield* rows.getForUserThread(thread)).toEqual(next);
          const quiet = linkInput("user-a");
          yield* links.upsert({
            ...quiet,
            request: { ...quiet.request, liveActivitiesEnabled: false },
          });
          expect(yield* rows.listForUser({ userId: "user-a" })).toEqual([]);
          expect(yield* rows.getForUserThread(thread)).toEqual(next);
          yield* links.revokeForUser({ userId: "user-a", environmentId });
          expect(yield* rows.getForUserThread(thread)).toBeNull();
          expect(yield* rows.listForUser({ userId: "user-b" })).toEqual([next]);
          expect(yield* rows.listForUser({ userId: "user-c" })).toEqual([waiting]);
          yield* rows.remove({ ...key, threadId: state.threadId });
          yield* rows.remove({ ...key, threadId: state.threadId });
          expect(yield* rows.listForUser({ userId: "user-b" })).toEqual([]);
          expect(yield* rows.listForUser({ userId: "user-c" })).toEqual([waiting]);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "orders by supplied update time and prunes only terminal rows strictly older than the boundary",
      () =>
        Effect.gen(function* () {
          const links = yield* EnvironmentLinkPersistence;
          const rows = yield* AgentActivityPersistence;
          yield* links.upsert(linkInput("user-a"));
          const cutoff = "2026-01-02T00:00:00.000Z";
          const states = [
            activity("completed", "2026-01-01T00:00:00.000Z"),
            { ...activity("failed", cutoff), threadId: ThreadId.make("thread-b") },
            {
              ...activity("running", "2025-12-31T00:00:00.000Z"),
              threadId: ThreadId.make("thread-c"),
            },
            {
              ...activity("stale", "2025-12-30T00:00:00.000Z"),
              threadId: ThreadId.make("thread-d"),
            },
          ];
          for (const state of states) yield* rows.upsert({ environmentPublicKey: "key-a", state });
          expect(yield* rows.listForUser({ userId: "user-a" })).toEqual([
            states[1],
            states[0],
            states[2],
            states[3],
          ]);
          yield* rows.pruneTerminal({ updatedBefore: cutoff });
          expect(yield* rows.listForUser({ userId: "user-a" })).toEqual([
            states[1],
            states[2],
            states[3],
          ]);
          yield* rows.pruneTerminal({ updatedBefore: "2026-01-03T00:00:00.000Z" });
          expect(yield* rows.listForUser({ userId: "user-a" })).toEqual([states[2], states[3]]);
        }).pipe(Effect.provide(layer)),
    );
  });
}
