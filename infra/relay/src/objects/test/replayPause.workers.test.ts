import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";
import {
  generateDpopPrivateJwk,
  importDpopProofKey,
  signDpopProof,
} from "@t3tools/shared/dpopProof";

import * as DpopProofs from "../../auth/DpopProofs.ts";
import { ApiPausePersistence } from "../../persistence/DeliveryPersistence.ts";
import { ReplayPersistence } from "../../persistence/IdentityPersistence.ts";
import { apiPauseContract } from "../../test/deliveryPersistenceContract.ts";
import { apiPauseLayer, type ApiPauseBindings } from "../ApiPausePersistence.ts";
import { replayLayer, type ReplayBindings } from "../ReplayPersistence.ts";
import { apiPauseName, replayName, inventoryShardName } from "../names.ts";

declare global {
  namespace Cloudflare {
    interface Env extends ReplayBindings, ApiPauseBindings {}
  }
}
const version = 1;
const input = (thumbprint: string) => ({
  thumbprint,
  jti: "proof-a",
  iat: 0,
  expiresAt: DateTime.makeUnsafe(1000),
});
function unavailableNamespace(): never {
  throw new Error("Synthetic object storage outage");
}
async function errorOf(call: () => Promise<unknown>) {
  try {
    await call();
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected RPC failure");
}
apiPauseContract(
  "SQLite object API pause",
  Layer.effectContext(
    Effect.gen(function* () {
      yield* Effect.promise(() => reset());
      return yield* Layer.build(apiPauseLayer(env));
    }),
  ),
);

it("leaves no application schema on cold reads, unregistered probes or invalid RPC envelopes", async () => {
  await reset();
  const replay = env.REPLAYS.getByName(replayName("cold", "proof-a"));
  const pause = env.API_PAUSES.getByName(apiPauseName("cold"));
  expect(
    await replay.consume({
      version,
      thumbprint: "cold",
      jti: "proof-a",
      iat: 0,
      expiresAt: "1970-01-01T00:00:01.000Z",
      createdAt: "1970-01-01T00:00:00.000Z",
    }),
  ).toEqual({ needsRegistration: true });
  await replay.prune({ version, expiresBefore: "1970-01-01T00:00:02.000Z" });
  expect(await pause.read({ version, api: "cold" })).toBe(0);
  expect(await pause.extend({ version, api: "cold", untilMillis: 1000 })).toEqual({
    needsRegistration: true,
  });
  expect(await errorOf(() => pause.read({ version: 0, api: "cold" }))).toContain("unsupported");
  expect(await errorOf(() => pause.read({ version, api: "another" }))).toContain("mismatch");
  await runInDurableObject(replay, (_instance, ctx) => {
    expect(
      ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name IN ('replay_proofs', 'relay_object_schema')",
        )
        .toArray(),
    ).toEqual([]);
  });
  await runInDurableObject(pause, (_instance, ctx) => {
    expect(
      ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name IN ('api_pause', 'relay_object_schema')")
        .toArray(),
    ).toEqual([]);
  });
});

it.effect("shares pause state between independent callers and across restart", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    const first = yield* ApiPausePersistence.pipe(Effect.provide(apiPauseLayer(env)));
    const second = yield* ApiPausePersistence.pipe(Effect.provide(apiPauseLayer(env)));
    yield* Effect.all([first.pauseUntil(1000), second.pauseUntil(3000), first.pauseUntil(2000)], {
      concurrency: "unbounded",
    });
    yield* Effect.promise(() => abortAllDurableObjects());
    expect(yield* second.pausedUntilMillis).toBe(3000);
    yield* second.pauseUntil(5000);
    expect(yield* first.pausedUntilMillis).toBe(5000);
    expect(
      (yield* Effect.promise(() =>
        env.API_PAUSES.getByName(apiPauseName("cloudflare")).inventory({ version }),
      )).tables[0]?.count,
    ).toBe(1);
  }),
);

it.effect("consumes one JTI concurrently and keeps hot operations independent of inventory", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    const replay = yield* ReplayPersistence.pipe(Effect.provide(replayLayer(env)));
    expect(
      (yield* Effect.all(
        Array.from({ length: 12 }, () => replay.consume(input("key-a"))),
        { concurrency: "unbounded" },
      )).filter(Boolean),
    ).toHaveLength(1);
    const pause = yield* ApiPausePersistence.pipe(Effect.provide(apiPauseLayer(env)));
    yield* pause.pauseUntil(1000);
    const unavailable = { getByName: unavailableNamespace };
    const hotReplay = yield* ReplayPersistence.pipe(
      Effect.provide(replayLayer({ ...env, INVENTORY: unavailable })),
    );
    const hotPause = yield* ApiPausePersistence.pipe(
      Effect.provide(apiPauseLayer({ ...env, INVENTORY: unavailable })),
    );
    expect(yield* hotReplay.consume(input("key-a"))).toBe(false);
    expect(yield* hotReplay.consume({ ...input("key-a"), jti: "proof-b" })).toBe(true);
    yield* hotPause.pauseUntil(2000);
    expect(yield* hotPause.pausedUntilMillis).toBe(2000);
    expect(yield* hotReplay.consume(input("key-cold")).pipe(Effect.flip)).toMatchObject({
      _tag: "DpopProofReplayPersistenceError",
      operation: "consume",
    });
    expect(
      (yield* Effect.promise(() =>
        env.REPLAYS.getByName(replayName("key-cold", "proof-a")).inventory({ version }),
      )).schemaVersion,
    ).toBe(0);
  }),
);

it.effect(
  "consumes challenge JTIs once across fixed shards and prunes at the strict boundary",
  () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => reset());
      const replay = yield* ReplayPersistence.pipe(Effect.provide(replayLayer(env)));
      const proofs = Array.from({ length: 8 }, (_, i) => ({
        ...input("relay-environment-link-challenge"),
        jti: `challenge-${i}`,
      }));
      expect(new Set(proofs.map((p) => replayName(p.thumbprint, p.jti))).size).toBeGreaterThan(1);
      const results = yield* Effect.all(
        proofs.flatMap((p) => [replay.consume(p), replay.consume(p)]),
        { concurrency: "unbounded" },
      );
      expect(results.filter(Boolean)).toHaveLength(proofs.length);
      yield* TestClock.setTime(1000);
      yield* replay.pruneExpired;
      expect(yield* Effect.forEach(proofs, (p) => replay.consume(p))).toEqual(
        proofs.map(() => false),
      );
      yield* TestClock.adjust("1 millis");
      yield* replay.pruneExpired;
      expect(yield* Effect.forEach(proofs, (p) => replay.consume(p))).toEqual(
        proofs.map(() => true),
      );
    }),
);

it.effect("fails closed for replay and open for advisory pause on unavailable storage", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    const unavailable = { getByName: unavailableNamespace };
    const replay = yield* ReplayPersistence.pipe(
      Effect.provide(replayLayer({ ...env, REPLAYS: unavailable, INVENTORY: unavailable })),
    );
    expect(yield* replay.consume(input("unavailable")).pipe(Effect.flip)).toMatchObject({
      _tag: "DpopProofReplayPersistenceError",
      operation: "consume",
    });
    expect(yield* replay.pruneExpired.pipe(Effect.flip)).toMatchObject({
      _tag: "DpopProofReplayPersistenceError",
      operation: "prune-expired",
    });
    const pause = yield* ApiPausePersistence.pipe(
      Effect.provide(apiPauseLayer({ ...env, API_PAUSES: unavailable })),
    );
    expect(yield* pause.pausedUntilMillis).toBe(0);
    yield* pause.pauseUntil(3000);
    const proof = yield* DpopProofs.DpopProofReplay.pipe(
      Effect.provide(
        DpopProofs.layer.pipe(Layer.provide(replayLayer({ ...env, REPLAYS: unavailable }))),
      ),
    );
    expect(
      yield* proof
        .verifyAndConsume({
          proof: undefined,
          method: "POST",
          url: "https://relay.example.test/v1/auth/token",
          now: DateTime.makeUnsafe(0),
        })
        .pipe(Effect.flip),
    ).toMatchObject({ _tag: "DpopProofRejected", code: "missing_proof" });
  }),
);

it.effect("recovers inventory interruption before a first replay or pause write", () => {
  const lostInventory = {
    getByName(name: string) {
      const stub = env.INVENTORY.getByName(name);
      return new Proxy(stub, {
        get(target, method) {
          if (method === "register")
            return async (request: Parameters<typeof stub.register>[0]) => {
              await stub.register(request);
              throw new Error("Synthetic lost inventory reply");
            };
          return Reflect.get(target, method, target);
        },
      });
    },
  };
  return Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    const replay = yield* ReplayPersistence.pipe(
      Effect.provide(replayLayer({ ...env, INVENTORY: lostInventory })),
    );
    const pause = yield* ApiPausePersistence.pipe(
      Effect.provide(apiPauseLayer({ ...env, INVENTORY: lostInventory })),
    );
    expect(yield* replay.consume(input("inventory-loss")).pipe(Effect.flip)).toMatchObject({
      operation: "consume",
    });
    yield* pause.pauseUntil(3000);
    expect(yield* pause.pausedUntilMillis).toBe(0);
    const replayObject = replayName("inventory-loss", "proof-a");
    expect(
      (yield* Effect.promise(() => env.REPLAYS.getByName(replayObject).inventory({ version })))
        .schemaVersion,
    ).toBe(0);
    for (const [kind, name] of [
      ["replay", replayObject],
      ["api-pause", apiPauseName("cloudflare")],
    ] as const) {
      expect(
        yield* Effect.promise(() =>
          env.INVENTORY.getByName(inventoryShardName(kind, name)).list({
            version,
            kind,
            after: "",
            limit: 1000,
          }),
        ),
      ).toContainEqual({ name });
    }
    yield* Effect.promise(() => abortAllDurableObjects());
    const recoveredReplay = yield* ReplayPersistence.pipe(Effect.provide(replayLayer(env)));
    const recoveredPause = yield* ApiPausePersistence.pipe(Effect.provide(apiPauseLayer(env)));
    expect(yield* recoveredReplay.consume(input("inventory-loss"))).toBe(true);
    yield* recoveredPause.pauseUntil(3000);
    expect(yield* recoveredPause.pausedUntilMillis).toBe(3000);
  });
});

it.effect(
  "keeps a consumed proof spent and pause recorded after lost write replies and restart",
  () => {
    const lostReplay = {
      getByName(name: string) {
        const stub = env.REPLAYS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "consume")
              return async (request: Parameters<typeof stub.consume>[0]) => {
                const result = await stub.consume(request);
                if ("consumed" in result) throw new Error("Synthetic lost consume reply");
                return result;
              };
            return Reflect.get(target, method, target);
          },
        });
      },
    };
    const lostPause = {
      getByName(name: string) {
        const stub = env.API_PAUSES.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "extend")
              return async (request: Parameters<typeof stub.extend>[0]) => {
                const result = await stub.extend(request);
                if ("extended" in result) throw new Error("Synthetic lost extend reply");
                return result;
              };
            return Reflect.get(target, method, target);
          },
        });
      },
    };
    return Effect.gen(function* () {
      yield* Effect.promise(() => reset());
      const replay = yield* ReplayPersistence.pipe(
        Effect.provide(replayLayer({ ...env, REPLAYS: lostReplay })),
      );
      const pause = yield* ApiPausePersistence.pipe(
        Effect.provide(apiPauseLayer({ ...env, API_PAUSES: lostPause })),
      );
      expect(yield* replay.consume(input("write-loss")).pipe(Effect.flip)).toMatchObject({
        operation: "consume",
      });
      const name = replayName("write-loss", "proof-a");
      expect(
        (yield* Effect.promise(() => env.REPLAYS.getByName(name).inventory({ version }))).tables[0]
          ?.count,
      ).toBe(1);
      yield* pause.pauseUntil(3000);
      yield* Effect.promise(() => abortAllDurableObjects());
      const recoveredReplay = yield* ReplayPersistence.pipe(Effect.provide(replayLayer(env)));
      const recoveredPause = yield* ApiPausePersistence.pipe(Effect.provide(apiPauseLayer(env)));
      expect(yield* recoveredReplay.consume(input("write-loss"))).toBe(false);
      expect(yield* recoveredPause.pausedUntilMillis).toBe(3000);
      yield* recoveredPause.pauseUntil(2000);
      expect(yield* recoveredPause.pausedUntilMillis).toBe(3000);
    });
  },
);

it.effect(
  "retains a future signed proof through the final rounded second and prunes strictly after expiry",
  () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => reset());
      yield* TestClock.setTime(300000);
      const key = yield* generateDpopPrivateJwk.pipe(Effect.flatMap(importDpopProofKey));
      const request = { method: "POST", url: "https://relay.example.test/v1/auth/token" };
      const signed = yield* signDpopProof({ key, ...request });
      yield* TestClock.setTime(0);
      const proof = yield* DpopProofs.DpopProofReplay;
      const input = { ...request, proof: signed, expectedThumbprint: key.thumbprint };
      const [header, payload, signature] = signed.split(".");
      const malformed = `${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
      const objectName = replayName(key.thumbprint, "any-jti");
      const shard = env.INVENTORY.getByName(inventoryShardName("replay", objectName));
      const before = yield* Effect.promise(() =>
        shard.list({ version, kind: "replay", after: "", limit: 1000 }),
      );
      expect(
        yield* proof
          .verifyAndConsume({ ...input, proof: malformed, now: DateTime.makeUnsafe(0) })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "DpopProofRejected", code: "invalid_signature" });
      expect(
        (yield* Effect.promise(() => env.REPLAYS.getByName(objectName).inventory({ version })))
          .schemaVersion,
      ).toBe(0);
      expect(
        yield* Effect.promise(() =>
          shard.list({ version, kind: "replay", after: "", limit: 1000 }),
        ),
      ).toEqual(before);
      expect(yield* proof.verifyAndConsume({ ...input, now: DateTime.makeUnsafe(0) })).toBe(
        key.thumbprint,
      );
      for (const [time, code] of [
        [301000, "replayed"],
        [600999, "replayed"],
        [601000, "time_window"],
      ] as const) {
        yield* TestClock.setTime(time);
        yield* proof.pruneExpired;
        expect(
          yield* proof
            .verifyAndConsume({ ...input, now: DateTime.makeUnsafe(time) })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "DpopProofRejected", code });
      }
      const name = replayName(key.thumbprint, "any-jti");
      const rows = yield* Effect.promise(() =>
        runInDurableObject(env.REPLAYS.getByName(name), (_instance, ctx) =>
          ctx.storage.sql.exec("SELECT expires_at FROM replay_proofs").toArray(),
        ),
      );
      expect(rows).toEqual([{ expires_at: "1970-01-01T00:10:01.000Z" }]);
      yield* TestClock.adjust("1 millis");
      yield* proof.pruneExpired;
      expect(
        (yield* Effect.promise(() => env.REPLAYS.getByName(name).inventory({ version }))).tables[0]
          ?.count,
      ).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DpopProofs.layer.pipe(Layer.provide(replayLayer(env))),
          SecureRandom.layerWebCrypto,
        ),
      ),
    ),
);
