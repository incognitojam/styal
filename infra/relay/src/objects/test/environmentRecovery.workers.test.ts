import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { EnvironmentCoordinator } from "../EnvironmentCoordinator.ts";
import type { EnvironmentBindings } from "../EnvironmentCoordinator.ts";
import type { LinkIntent, LinkCommand } from "../AccountLinks.ts";
import { environmentLayer, machineTokenHash } from "../EnvironmentPersistence.ts";
import { accountName, environmentName, credentialRouteName, inventoryShardName } from "../names.ts";
import { accountMigrations } from "../AccountObject.ts";
import { migrate } from "../storage.ts";
import {
  EnvironmentLinkPersistence,
  EnvironmentCredentialPersistence,
  AgentActivityPersistence,
} from "../../persistence/EnvironmentPersistence.ts";
import { EnvironmentLinkCompletionPersistence } from "../../persistence/EnvironmentLinkCompletionPersistence.ts";

const now = "2026-01-01T00:00:00.000Z";
const layer = environmentLayer(env).pipe(Layer.provide(SecureRandom.layerWebCrypto));
function intent(userId: string, environmentId: string, environmentPublicKey = "key-a"): LinkIntent {
  return {
    userId,
    environmentId,
    environmentPublicKey,
    label: "Synthetic machine",
    endpoint: {
      httpBaseUrl: "https://endpoint.example.test",
      wsBaseUrl: "wss://endpoint.example.test",
      providerKind: "cloudflare_tunnel",
    },
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    managedTunnelsEnabled: true,
    createdByDeviceId: null,
  };
}
function request(userId: string, id: string, publicKey = "key-a") {
  const environmentId = EnvironmentId.make(id);
  const l = intent(userId, environmentId, publicKey);
  return {
    userId,
    request: {
      proof: "already-verified",
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: true,
    },
    proof: {
      environmentId,
      environmentPublicKey: publicKey,
      iss: "environment",
      aud: "relay",
      sub: environmentId,
      jti: `proof-${userId}`,
      iat: 0,
      exp: 300,
      challenge: "verified",
      descriptor: {
        environmentId,
        label: l.label,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      endpoint: l.endpoint,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3000 },
      scopes: ["managed_tunnels"],
    },
    endpoint: l.endpoint,
  } satisfies Parameters<EnvironmentLinkPersistence["Service"]["upsert"]>[0];
}
function credential(index: number) {
  const credentialId = String(index).padStart(64, "a");
  const token = `t3env_${credentialId}_${"b".repeat(96)}`;
  return { token, credentialId, tokenHash: machineTokenHash(token) };
}
async function errorOf(body: () => Promise<unknown>) {
  try {
    await body();
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected failure");
}

it("recovers every link/credential publication interruption after abort and reacquire, without an intermediate grant", async () => {
  await reset();
  for (let stage = 0; stage <= 6; stage++) {
    const c = new EnvironmentCoordinator(env);
    const environmentId = `restart-${stage}`;
    const material = credential(stage);
    const desired = {
      ...intent(`owner-${stage}`, environmentId),
      credential: { credentialId: material.credentialId, tokenHash: material.tokenHash },
    };
    const link = await c.beginLink(desired, `operation-${stage}`, now);
    const reference = { kind: "environment" as const, name: environmentName(environmentId) };
    expect(
      await env.INVENTORY.getByName(inventoryShardName(reference.kind, reference.name)).list({
        version: 1,
        kind: "environment",
        after: "",
        limit: 1000,
      }),
    ).toContainEqual({ name: reference.name });
    if (stage >= 1) await c.installCandidate(link);
    if (stage >= 2)
      await c.environment(environmentId).installCredential({
        version: 1,
        environmentId,
        credential: {
          ...desired.credential,
          environmentPublicKey: link.environmentPublicKey,
          createdAt: now,
        },
      });
    if (stage >= 3) {
      await c.register("credential-route", credentialRouteName("machine", material.tokenHash));
      await c.route(material.tokenHash).publish({ version: 1, destination: environmentId });
    }
    if (stage >= 4)
      await c
        .environment(environmentId)
        .publishCredential({ version: 1, environmentId, tokenHash: material.tokenHash });
    if (stage >= 5)
      await c.command(link.userId, {
        kind: "publish",
        environmentId,
        operationId: link.operationId,
        generation: link.generation,
      });
    if (stage >= 6) await c.publishLink(link);
    expect((await c.authenticate(material.tokenHash)) !== null).toBe(stage === 6);
    await abortAllDurableObjects();
    const restarted = new EnvironmentCoordinator(env);
    expect((await restarted.authenticate(material.tokenHash)) !== null).toBe(stage === 6);
    await restarted.finishLink(link);
    expect(await restarted.authenticate(material.tokenHash)).toMatchObject({
      environmentId,
      environmentPublicKey: "key-a",
      credentialId: material.credentialId,
    });
    await abortAllDurableObjects();
    const retry = new EnvironmentCoordinator(env);
    await retry.finishLink(await retry.beginLink(desired, link.operationId, now));
    expect(await retry.authenticate(material.tokenHash)).not.toBeNull();
    expect(
      (await retry.environment(environmentId).inventory({ version: 1 })).tables.find(
        (t) => t.table === "credentials",
      )?.count,
    ).toBe(1);
  }
});

it.effect(
  "keeps shared owners and activity independent through unlink/relink interruptions and rejects stale retries",
  () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => reset());
      const completion = yield* EnvironmentLinkCompletionPersistence;
      const links = yield* EnvironmentLinkPersistence;
      const credentials = yield* EnvironmentCredentialPersistence;
      const rows = yield* AgentActivityPersistence;
      const environmentId = EnvironmentId.make("shared-machine");
      const tokens = yield* Effect.all(
        [
          completion.complete(request("owner-a", environmentId)),
          completion.complete(request("owner-b", environmentId)),
        ],
        { concurrency: "unbounded" },
      );
      expect(yield* links.listForUser({ userId: "owner-a" })).toHaveLength(1);
      expect(yield* links.listForUser({ userId: "owner-b" })).toHaveLength(1);
      const token = Option.isSome(yield* credentials.authenticate(tokens[0]!))
        ? tokens[0]!
        : tokens[1]!;
      expect(Option.isSome(yield* credentials.authenticate(token))).toBe(true);
      const state = {
        environmentId,
        threadId: ThreadId.make("thread-a"),
        projectTitle: "Synthetic project",
        threadTitle: "Synthetic thread",
        modelTitle: "Synthetic model",
        phase: "running" as const,
        headline: "Working",
        updatedAt: now,
        deepLink: "/threads/shared-machine/thread-a",
      };
      yield* rows.upsert({ environmentPublicKey: "key-a", state });
      const c = new EnvironmentCoordinator(env);
      const before = yield* Effect.promise(() => c.read("owner-b", environmentId));
      if (!before) return yield* Effect.die("Missing owner");
      yield* Effect.promise(() =>
        c.command("owner-a", { kind: "revoke", environmentId, operationId: "unlink-a", now }),
      );
      expect(
        yield* rows.getForUserThread({
          userId: "owner-a",
          environmentId,
          threadId: state.threadId,
        }),
      ).toBeNull();
      expect(yield* rows.listForUser({ userId: "owner-b" })).toEqual([state]);
      yield* Effect.promise(() => abortAllDurableObjects());
      yield* Effect.promise(() =>
        new EnvironmentCoordinator(env).revoke("owner-a", environmentId, "unlink-a", now),
      );
      expect(
        yield* credentials.revokeForEnvironmentPublicKey({
          environmentId,
          environmentPublicKey: "key-a",
        }),
      ).toBe(false);
      expect(Option.isSome(yield* credentials.authenticate(token))).toBe(true);
      const newToken = yield* completion.complete(request("owner-b", environmentId, "key-b"));
      expect(yield* credentials.authenticate(token)).toEqual(Option.none());
      expect(Option.isSome(yield* credentials.authenticate(newToken))).toBe(true);
      yield* Effect.promise(() => abortAllDurableObjects());
      expect(
        yield* Effect.promise(() =>
          errorOf(() => new EnvironmentCoordinator(env).finishLink(before)),
        ),
      ).toContain("superseded");
      expect(
        yield* Effect.promise(() =>
          errorOf(() =>
            new EnvironmentCoordinator(env).beginLink(
              { ...intent("owner-b", environmentId), credential: before.credential! },
              before.operationId,
              now,
            ),
          ),
        ),
      ).toContain("superseded");
      const sharedToken = yield* completion.complete(request("owner-a", environmentId, "key-b"));
      yield* Effect.promise(() =>
        new EnvironmentCoordinator(env).revoke("owner-a", environmentId, "unlink-a", now),
      );
      expect(yield* links.getForUser({ userId: "owner-a", environmentId })).not.toBeNull();
      yield* rows.upsert({ environmentPublicKey: "key-b", state });
      yield* links.revokeForUser({ userId: "owner-a", environmentId });
      expect(yield* rows.listForUser({ userId: "owner-b" })).toEqual([state]);
      expect(Option.isSome(yield* credentials.authenticate(sharedToken))).toBe(true);
      expect(
        yield* credentials.revokeForEnvironmentPublicKey({
          environmentId,
          environmentPublicKey: "key-b",
        }),
      ).toBe(false);
      for (const initial of ["absent", "revoked"] as const) {
        const id = `noop-${initial}`;
        const nc = new EnvironmentCoordinator(env);
        if (initial === "revoked") {
          yield* Effect.promise(() =>
            nc.upsert(intent("noop-owner", id), `initial-${initial}`, now),
          );
          yield* Effect.promise(() =>
            nc.revoke("noop-owner", id, `initial-unlink-${initial}`, now),
          );
        }
        expect(
          yield* Effect.promise(() => nc.revoke("noop-owner", id, `noop-unlink-${initial}`, now)),
        ).toBe(false);
        yield* Effect.promise(() => abortAllDurableObjects());
        const live = yield* completion.complete(request("noop-owner", id));
        expect(
          yield* Effect.promise(() => nc.revoke("noop-owner", id, `noop-unlink-${initial}`, now)),
        ).toBe(false);
        expect(yield* links.getForUser({ userId: "noop-owner", environmentId: id })).not.toBeNull();
        expect(Option.isSome(yield* credentials.authenticate(live))).toBe(true);
      }
    }).pipe(Effect.provide(layer)),
);

it("never revives a rotated or revoked credential when publication replies are lost", async () => {
  await reset();
  const c = new EnvironmentCoordinator(env);
  const delayedId = "delayed-first-install";
  const a = credential(40);
  const b = credential(41);
  const oldLink = await c.beginLink(
    {
      ...intent("delayed-owner", delayedId),
      credential: { credentialId: a.credentialId, tokenHash: a.tokenHash },
    },
    "delayed-a",
    now,
  );
  await c.installCandidate(oldLink);
  const newLink = await c.beginLink(
    {
      ...intent("delayed-owner", delayedId),
      credential: { credentialId: b.credentialId, tokenHash: b.tokenHash },
    },
    "delayed-b",
    now,
  );
  await c.finishLink(newLink);
  expect(await c.authenticate(b.tokenHash)).not.toBeNull();
  await abortAllDurableObjects();
  let failure = "";
  try {
    await c.publishCredential(delayedId, {
      credentialId: a.credentialId,
      tokenHash: a.tokenHash,
      environmentPublicKey: "key-a",
      createdAt: now,
      link: { userId: oldLink.userId, generation: oldLink.generation },
    });
  } catch (error) {
    failure = String(error);
  }
  expect(await c.authenticate(b.tokenHash)).not.toBeNull();
  expect(failure).toContain("superseded");
  await abortAllDurableObjects();
  await c.finishLink(newLink);
  expect(await c.authenticate(b.tokenHash)).not.toBeNull();
  const environmentId = "credential-retry";
  await c.upsert(intent("owner", environmentId), "link", now);
  const old = credential(10);
  const next = credential(11);
  const publish = (v: typeof old) =>
    c.publishCredential(environmentId, {
      credentialId: v.credentialId,
      tokenHash: v.tokenHash,
      environmentPublicKey: "key-a",
      createdAt: now,
    });
  await publish(old);
  await publish(next);
  await abortAllDurableObjects();
  await publish(old);
  expect(await c.authenticate(old.tokenHash)).toBeNull();
  expect(await c.authenticate(next.tokenHash)).not.toBeNull();
  await c.revoke("owner", environmentId, "unlink", now);
  expect(
    await c
      .environment(environmentId)
      .revokeCredentials({ version: 1, environmentId, environmentPublicKey: "key-a" }),
  ).toBe(true);
  await abortAllDurableObjects();
  await publish(next);
  await c.upsert(intent("owner", environmentId), "relink", now);
  expect(await c.authenticate(next.tokenHash)).toBeNull();
});

it("does not persist unknown routing lookups and keeps auth/unlink RPCs constant without inventory discovery", async () => {
  await reset();
  const c = new EnvironmentCoordinator(env);
  for (let i = 20; i < 23; i++) {
    const tokenHash = credential(i).tokenHash;
    expect(await c.authenticate(tokenHash)).toBeNull();
    await runInDurableObject(c.route(tokenHash), (_object, ctx) => {
      expect(
        ctx.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name IN ('relay_object_schema', 'credential_route')",
          )
          .toArray(),
      ).toEqual([]);
    });
  }
  expect(
    await c.environment("unknown").candidates({ version: 1, environmentId: "unknown" }),
  ).toEqual([]);
  await runInDurableObject(c.environment("unknown"), (_object, ctx) => {
    expect(
      ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name IN ('relay_object_schema', 'candidates')")
        .toArray(),
    ).toEqual([]);
  });
  const environmentId = "bounded-auth";
  await c.upsert(intent("owner", environmentId), "link", now);
  const token = credential(30);
  await c.publishCredential(environmentId, {
    credentialId: token.credentialId,
    tokenHash: token.tokenHash,
    environmentPublicKey: "key-a",
    createdAt: now,
  });
  const calls: string[] = [];
  class Bounded extends EnvironmentCoordinator {
    override route(hash: string) {
      calls.push("route");
      return super.route(hash);
    }
    override environment(id: string) {
      calls.push("environment");
      return super.environment(id);
    }
    override async command(userId: string, command: LinkCommand) {
      calls.push("account");
      return await super.command(userId, command);
    }
    override async register(kind: Parameters<EnvironmentCoordinator["register"]>[0], name: string) {
      calls.push("inventory-write");
      await super.register(kind, name);
    }
    override async owners(): Promise<never> {
      throw new Error("Unexpected owner scan");
    }
  }
  const bindings = {
    ...env,
    INVENTORY: {
      getByName: () => {
        throw new Error("Unexpected inventory access");
      },
    },
  } as unknown as EnvironmentBindings;
  const bounded = new Bounded(bindings);
  expect(await bounded.authenticate(token.tokenHash)).not.toBeNull();
  expect(calls).toEqual(["route", "environment", "account"]);
  calls.length = 0;
  expect(await new Bounded(env).revoke("owner", environmentId, "unlink", now)).toBe(true);
  expect(calls).toEqual(["inventory-write", "account", "environment"]);
  await abortAllDurableObjects();
  expect(await bounded.authenticate(token.tokenHash)).toBeNull();
  await runInDurableObject(c.route(token.tokenHash), (_object, ctx) => {
    ctx.storage.sql.exec("UPDATE relay_object_schema SET version = 2");
  });
  await runInDurableObject(c.environment(environmentId), (_object, ctx) => {
    ctx.storage.sql.exec("UPDATE relay_object_schema SET version = 2");
  });
  await abortAllDurableObjects();
  expect(
    await errorOf(async () => await c.route(token.tokenHash).resolve({ version: 1 })),
  ).toContain("newer than supported");
  expect(
    await errorOf(
      async () => await c.environment(environmentId).candidates({ version: 1, environmentId }),
    ),
  ).toContain("newer than supported");
});

it("upgrades piece-four account storage without altering identity, session or pending journal rows", async () => {
  await reset();
  const userId = "schema-owner";
  const stub = env.ACCOUNTS.getByName(accountName(userId));
  const profile = {
    userId,
    email: null,
    epoch: 1,
    mapping: null,
    pending: null,
    createdAt: now,
    updatedAt: now,
    lastSignInAt: null,
  };
  await runInDurableObject(stub, async (_object, ctx) => {
    await ctx.storage.deleteAll();
    migrate(ctx.storage, accountMigrations.slice(0, 2));
    ctx.storage.sql.exec("INSERT INTO account_identity VALUES (1, ?)", JSON.stringify(profile));
    ctx.storage.sql.exec(
      "INSERT INTO account_sessions VALUES ('session-a', ?)",
      JSON.stringify({ userId, sessionId: "session-a", published: false, revoked: false }),
    );
    ctx.storage.sql.exec(
      "INSERT INTO tunnel_operations VALUES ('environment-a','operation-a',?,'endpoint.example.test','tunnel-a','{}','intent','{}',?)",
      userId,
      now,
    );
  });
  await abortAllDurableObjects();
  const reopened = env.ACCOUNTS.getByName(accountName(userId));
  await runInDurableObject(reopened, (_object, ctx) => {
    expect(ctx.storage.sql.exec("SELECT version FROM relay_object_schema").one().version).toBe(
      accountMigrations.length,
    );
    expect(
      JSON.parse(String(ctx.storage.sql.exec("SELECT value FROM account_identity").one().value)),
    ).toEqual(profile);
    expect(ctx.storage.sql.exec("SELECT session_id FROM account_sessions").toArray()).toEqual([
      { session_id: "session-a" },
    ]);
    expect(
      ctx.storage.sql.exec("SELECT operation_id, phase FROM tunnel_operations").toArray(),
    ).toEqual([{ operation_id: "operation-a", phase: "intent" }]);
    expect(ctx.storage.sql.exec("SELECT * FROM account_links").toArray()).toEqual([]);
  });
  await new EnvironmentCoordinator(env).upsert(
    intent(userId, "schema-environment"),
    "new-link",
    now,
  );
  await abortAllDurableObjects();
  expect(
    (await env.ACCOUNTS.getByName(accountName(userId)).inventory({ version: 1 })).tables.find(
      (t) => t.table === "account_sessions",
    )?.count,
  ).toBe(1);
});
