import * as Effect from "effect/Effect";
import type { TunnelOperationIntent } from "../../persistence/TunnelOperationPersistence.ts";
import { TunnelOperationPersistence } from "../../persistence/TunnelOperationPersistence.ts";
import { tunnelOperationsLayer } from "../TunnelOperations.ts";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { accountMigrations } from "../AccountObject.ts";
import {
  accountName,
  credentialRouteName,
  emailName,
  environmentName,
  replayName,
  pushTokenName,
  deliveryAttemptName,
  apiPauseName,
  inventoryShardName,
} from "../names.ts";
import { canonicalJson, migrate, RPC_VERSION, summarize } from "../storage.ts";

const intent = {
  userId: "user-a",
  environmentId: "env-a",
  hostname: "endpoint.example.test",
  tunnelName: "managed-a",
  desired: {
    kind: "provision" as const,
    origin: { localHttpHost: "localhost", localHttpPort: 3000 },
  },
};

it("routes exact identities with stable purpose separation and keyed email names", () => {
  expect(accountName("a")).toBe(
    "account:v1:afa30193ec72600ce201beae39bfad9bc800b7d0b8da864928ef6d6a0fdb0b3c",
  );
  expect(accountName("a")).not.toBe(environmentName("a"));
  expect(credentialRouteName("session", "a")).not.toBe(credentialRouteName("machine", "a"));
  expect(pushTokenName("push", "a")).not.toBe(pushTokenName("push-to-start", "a"));
  expect(deliveryAttemptName("attempt", "a")).not.toBe(deliveryAttemptName("source-job", "a"));
  expect(apiPauseName("a")).not.toBe(apiPauseName("b"));
  expect(inventoryShardName("account", accountName("a"))).toMatch(/^inventory:v1:[0-9a-f]$/);
  const key = new Uint8Array(32).fill(1);
  expect(emailName("user@example.test", key)).not.toContain("user@example.test");
  expect(emailName("user@example.test", key)).not.toBe(
    emailName("user@example.test", new Uint8Array(32).fill(2)),
  );
  expect(replayName("key-a", "jti-a")).toBe(replayName("key-a", "jti-b"));
  expect(replayName("key-a", "jti-a")).not.toBe(replayName("key-b", "jti-a"));
  expect(
    new Set(
      Array.from({ length: 100 }, (_, i) =>
        replayName("relay-environment-link-challenge", String(i)),
      ),
    ).size,
  ).toBeGreaterThan(1);
  expect(canonicalJson({ b: null, a: { y: 2, x: 1 } })).toBe(
    canonicalJson({ a: { x: 1, y: 2 }, b: null }),
  );
  expect(summarize("t", [{ a: null }])).not.toEqual(summarize("t", [{ a: "" }]));
});

it("migrates fresh and dormant storage atomically and rejects newer schemas", async () => {
  const stub = env.ACCOUNTS.getByName(accountName("migrations"));
  await runInDurableObject(stub, (_instance, ctx) => {
    const storage = ctx.storage;
    expect(migrate(storage, accountMigrations)).toBe(1);
    const upgrade = [...accountMigrations, "CREATE TABLE upgrade_probe (value TEXT)"];
    expect(migrate(storage, upgrade)).toBe(2);
    storage.sql.exec("INSERT INTO upgrade_probe VALUES ('retained')");
    expect(() => migrate(storage, accountMigrations)).toThrow("newer than supported");
    expect(migrate(storage, upgrade)).toBe(2);
    expect(storage.sql.exec("SELECT * FROM upgrade_probe").toArray()).toEqual([
      { value: "retained" },
    ]);
    expect(() =>
      migrate(storage, [
        ...upgrade,
        "CREATE TABLE rolled_back (id TEXT); INSERT INTO missing VALUES (1)",
      ]),
    ).toThrow();
    expect(storage.sql.exec("SELECT version FROM relay_object_schema").one().version).toBe(2);
    expect(
      storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'rolled_back'").toArray(),
    ).toEqual([]);
  });
  expect(
    (await env.ACCOUNTS.getByName(accountName("fresh")).inventory({ version: RPC_VERSION }))
      .schemaVersion,
  ).toBe(1);
});

it("rejects RPC skew before writes, rolls back batches, and serializes competing stubs", async () => {
  const stub = env.ACCOUNTS.getByName(accountName(intent.userId));
  expect(
    await (async () => {
      try {
        await stub.journal({ version: 2, commands: [{ kind: "begin", intent }] });
      } catch (error) {
        return String(error);
      }
      return "accepted";
    })(),
  ).toContain("RPC version 2");
  expect((await stub.inventory({ version: 1 })).tables[0]?.count).toBe(0);
  expect(
    await (async () => {
      try {
        await stub.journal({
          version: 1,
          commands: [
            { kind: "begin", intent },
            { kind: "pending", limit: 0 },
          ],
        });
      } catch (error) {
        return String(error);
      }
      return "accepted";
    })(),
  ).toContain("limit");
  expect((await stub.inventory({ version: 1 })).tables[0]?.count).toBe(0);
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      env.ACCOUNTS.getByName(accountName(intent.userId)).journal({
        version: 1,
        commands: [{ kind: "begin", intent }],
      }),
    ),
  );
  const first = results[0]?.[0];
  if (first?.kind !== "begin" || !first.operation) throw new Error("Missing operation");
  for (const result of results)
    expect(result[0]).toMatchObject({
      kind: "begin",
      operation: { operationId: first.operation.operationId },
    });
  const changed = await stub.journal({
    version: 1,
    commands: [
      {
        kind: "begin",
        intent: {
          ...intent,
          desired: { kind: "deprovision", target: { tunnelId: null, dnsRecordId: null } },
        },
      },
    ],
  });
  expect(changed[0]).not.toEqual(first);
  const stale = await Promise.all(
    Array.from({ length: 4 }, () =>
      env.ACCOUNTS.getByName(accountName(intent.userId)).journal({
        version: 1,
        commands: [
          {
            kind: "advance",
            operationId: first.operation!.operationId,
            phase: "complete",
            resources: {},
          },
        ],
      }),
    ),
  );
  expect(stale.flat()).toEqual(
    Array.from({ length: 4 }, () => ({ kind: "advance", applied: false })),
  );
  const inventory = await stub.inventory({ version: 1 });
  expect(inventory.tables[0]?.count).toBe(1);
  expect(inventory.tables[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(await stub.inventory({ version: 1 })).toEqual(inventory);
  expect(await env.ACCOUNTS.getByName(accountName("other")).inventory({ version: 1 })).not.toEqual(
    inventory,
  );
  expect(
    await (async () => {
      try {
        await env.INVENTORY.getByName("inventory:v1:0").register({
          version: 2,
          references: [{ kind: "account", name: "a" }],
        });
      } catch (error) {
        return String(error);
      }
      return "accepted";
    })(),
  ).toContain("RPC version 2");
  const serialization = env.ACCOUNTS.getByName(accountName("serialization"));
  const malformed = {
    ...intent,
    userId: "serialization",
    desired: { kind: "release", expectedStatus: undefined },
  } as unknown as TunnelOperationIntent;
  await serialization.journal({ version: 1, commands: [{ kind: "begin", intent: malformed }] });
  expect(
    await serialization.journal({ version: 1, commands: [{ kind: "pending", limit: 1 }] }),
  ).toMatchObject([{ kind: "pending", operations: [{ desired: { kind: "release" } }] }]);
  expect((await serialization.inventory({ version: 1 })).tables[0]?.count).toBe(1);
  await abortAllDurableObjects();
  expect(
    await env.ACCOUNTS.getByName(accountName(intent.userId)).inventory({ version: 1 }),
  ).toEqual(inventory);
});

it("pages idempotent inventory and hashes content independently of insertion order", async () => {
  const a = env.INVENTORY.getByName("inventory:v1:a");
  const b = env.INVENTORY.getByName("inventory:v1:b");
  const refs = [
    { kind: "account", name: "b" },
    { kind: "account", name: "a" },
  ];
  await a.register({ version: 1, references: refs });
  await a.register({ version: 1, references: refs });
  await b.register({ version: 1, references: refs.toReversed() });
  expect(await a.inventory({ version: 1 })).toEqual(await b.inventory({ version: 1 }));
  expect((await a.inventory({ version: 1 })).tables[0]?.count).toBe(2);
  expect(await a.list({ version: 1, kind: "account", after: "", limit: 1 })).toEqual([
    { name: "a" },
  ]);
  expect(await a.list({ version: 1, kind: "account", after: "a", limit: 1 })).toEqual([
    { name: "b" },
  ]);
});

it.effect(
  "discovers pending work across accounts in oldest-first order and routes completion",
  () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => reset());
      const journal = yield* TunnelOperationPersistence;
      const a = yield* journal.begin(intent);
      const b = yield* journal.begin({ ...intent, userId: "user-b" });
      if (!a || !b) throw new Error("Missing operations");
      yield* Effect.promise(() =>
        runInDurableObject(env.ACCOUNTS.getByName(accountName("user-a")), (_object, ctx) => {
          ctx.storage.sql.exec(
            "UPDATE tunnel_operations SET updated_at = '2026-01-02T00:00:00.000Z'",
          );
        }),
      );
      yield* Effect.promise(() =>
        runInDurableObject(env.ACCOUNTS.getByName(accountName("user-b")), (_object, ctx) => {
          ctx.storage.sql.exec(
            "UPDATE tunnel_operations SET updated_at = '2026-01-01T00:00:00.000Z'",
          );
        }),
      );
      expect((yield* journal.pending(1)).map((row) => row.operationId)).toEqual([b.operationId]);
      expect(yield* journal.complete(b.operationId)).toBe(true);
      expect((yield* journal.pending(2)).map((row) => row.operationId)).toEqual([a.operationId]);
    }).pipe(Effect.provide(tunnelOperationsLayer(env))),
);
