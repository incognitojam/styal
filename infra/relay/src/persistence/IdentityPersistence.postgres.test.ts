import * as PostgresRegistrationCleanup from "./PostgresRegistrationCleanup.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { config } from "../test/fixtures.ts";
import { identityPersistenceContract } from "../test/identityPersistenceContract.ts";
import { EmailPersistence } from "./IdentityPersistence.ts";
import { relayEmailSignInCodes } from "./schema.ts";
import * as PostgresAccounts from "./PostgresAccounts.ts";
import * as PostgresAuthSessions from "./PostgresAuthSessions.ts";
import * as PostgresEmailSignInCodes from "./PostgresEmailSignInCodes.ts";
import * as PostgresReplay from "./PostgresReplay.ts";

// Matches the existing relay Postgres harness; never accept a remote database.
const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
if (databaseUrl && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("Identity persistence contracts require a local Postgres database");
}
const layerDb = Layer.effect(RelayDb.RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl ?? "postgres://unused") })),
);
const layer = Layer.mergeAll(
  PostgresAccounts.layer,
  PostgresAuthSessions.layer.pipe(Layer.provide(PostgresRegistrationCleanup.layer)),
  PostgresEmailSignInCodes.layer,
  PostgresReplay.layer,
).pipe(
  Layer.provide(ApnsDeliveryQueue.layer),
  Layer.provide(
    Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
      send: () => Effect.die("Unexpected push send in identity contract"),
    }),
  ),
  Layer.provide(RelayConfiguration.layer(config)),
  Layer.provideMerge(layerDb),
  Layer.provideMerge(NodeCrypto.layer),
);

describe.skipIf(!databaseUrl)("Postgres", () => {
  identityPersistenceContract("identity persistence", layer);

  it.effect(
    "retains expired email codes for quotas, then removes them after the retention boundary",
    () =>
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const codes = yield* EmailPersistence;
        const id = yield* (yield* SecureRandom.SecureRandom).uuidV4();
        const issued = yield* codes.issue({ email: `ada-${id}@example.test`, thumbprint: "key" });
        yield* Effect.addFinalizer(() =>
          codes
            .discard({ email: `ada-${id}@example.test`, codeId: issued.codeId })
            .pipe(Effect.orDie),
        );
        const rows = db
          .select()
          .from(relayEmailSignInCodes)
          .where(eq(relayEmailSignInCodes.codeId, issued.codeId));
        yield* TestClock.adjust("10 minutes");
        yield* codes.pruneExpired;
        expect(yield* rows).toHaveLength(1);
        yield* TestClock.adjust("59 minutes");
        yield* codes.pruneExpired;
        expect(yield* rows).toHaveLength(1);
        yield* TestClock.adjust("1 minute");
        yield* codes.pruneExpired;
        expect(yield* rows).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
