import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { PGlite } from "@electric-sql/pglite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlError from "effect/sql/SqlError";

import { RelayDb } from "../db.ts";

class Transaction extends Context.Service<Transaction, true>()(
  "t3code-relay/test/localRelayDb/Transaction",
) {}

// Real Postgres statements against in-memory PGlite; no URL, sockets or credentials.
export const layerLocalRelayDb = Layer.effect(
  RelayDb,
  Effect.gen(function* () {
    const pg = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create()),
      (pg) => Effect.promise(() => pg.close()),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* path.fromFileUrl(new URL("../../migrations/postgres/", import.meta.url));
    for (const name of (yield* fs.readDirectory(dir)).toSorted()) {
      const migration = yield* fs.readFileString(path.join(dir, name, "migration.sql"));
      yield* Effect.promise(() => pg.exec(migration));
    }
    const lock = Semaphore.makeUnsafe(1);
    const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if ((yield* Effect.serviceOption(Transaction))._tag === "Some") return yield* effect;
        return yield* Effect.acquireUseRelease(
          Effect.promise(() => pg.exec("BEGIN")),
          () => effect.pipe(Effect.provideService(Transaction, true)),
          (_, exit) => Effect.promise(() => pg.exec(Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK")),
        ).pipe(lock.withPermit);
      });
    const client = {
      unsafe: (query: string, params: ReadonlyArray<unknown>) => ({
        values: Effect.tryPromise({
          try: () => pg.query(query, [...params], { rowMode: "array" }),
          catch: (cause) => new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause }) }),
        }).pipe(Effect.map((result) => result.rows)),
        withoutTransform: Effect.tryPromise({
          try: () => pg.query(query, [...params]),
          catch: (cause) => new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause }) }),
        }).pipe(Effect.map((result) => result.rows)),
        raw: Effect.tryPromise({
          try: () => pg.query(query, [...params]),
          catch: (cause) => new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause }) }),
        }),
      }),
      withTransaction,
    } as unknown as PgClient.PgClient;
    return yield* PgDrizzle.makeWithDefaults().pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
