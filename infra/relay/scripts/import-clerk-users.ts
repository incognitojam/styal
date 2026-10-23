// Copies Clerk users into relay_users under their Clerk ids, so a user who
// later signs in by email code keeps their environment links, devices and
// tunnels. Run before enabling email sign-in on a stage, and again after Clerk
// sign-ups are disabled.
//
//   CLERK_SECRET_KEY=sk_... RELAY_DATABASE_URL=postgres://... node scripts/import-clerk-users.ts [--apply]
//
// RELAY_DATABASE_URL is the stage's direct (non-pooled) Neon connection string.
// Without --apply nothing is written. Existing rows are left alone; an email
// that already belongs to another id is reported, not overwritten.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { eq } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as Accounts from "../src/auth/Accounts.ts";
import { ClerkUser, clerkUserEmail } from "../src/auth/clerkImport.ts";
import * as RelayDb from "../src/db.ts";
import { relayUsers } from "../src/persistence/schema.ts";

const PAGE_SIZE = 500;
const apply = process.argv.includes("--apply");

const main = Effect.gen(function* () {
  const clerkSecretKey = yield* Config.Redacted("CLERK_SECRET_KEY");
  const clerkApiUrl = yield* Config.String("CLERK_API_URL").pipe(
    Config.withDefault("https://api.clerk.com"),
  );
  const client = yield* HttpClient.HttpClient;
  const accounts = yield* Accounts.Accounts;
  const db = yield* RelayDb.RelayDb;

  const listPage = (offset: number) =>
    client
      .execute(
        HttpClientRequest.get(`${clerkApiUrl}/v1/users`).pipe(
          HttpClientRequest.setUrlParams({
            limit: String(PAGE_SIZE),
            offset: String(offset),
            order_by: "+created_at",
          }),
          HttpClientRequest.bearerToken(Redacted.value(clerkSecretKey)),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(ClerkUser))),
      );

  const counts = { users: 0, imported: 0, alreadyPresent: 0, noVerifiedEmail: 0, emailConflict: 0 };
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = yield* listPage(offset);
    for (const user of page) {
      counts.users += 1;
      const email = clerkUserEmail(user);
      if (email === null) {
        counts.noVerifiedEmail += 1;
        yield* Console.log(`skip ${user.id}: no verified email`);
        continue;
      }
      if (Option.isSome(yield* accounts.get(user.id))) {
        counts.alreadyPresent += 1;
        continue;
      }
      const owner = yield* db
        .select({ userId: relayUsers.userId })
        .from(relayUsers)
        .where(eq(relayUsers.email, email))
        .limit(1);
      if (owner[0]) {
        counts.emailConflict += 1;
        yield* Console.log(`conflict ${user.id}: email already belongs to ${owner[0].userId}`);
        continue;
      }
      if (apply) {
        yield* accounts.importAccount({ userId: user.id, email });
      }
      counts.imported += 1;
    }
    if (page.length < PAGE_SIZE) break;
  }
  yield* Console.log(
    `${apply ? "Imported" : "Would import"} ${counts.imported} of ${counts.users} Clerk users ` +
      `(${counts.alreadyPresent} already present, ${counts.noVerifiedEmail} without a verified email, ` +
      `${counts.emailConflict} email conflicts).`,
  );
});

const layerDb = Layer.effect(
  RelayDb.RelayDb,
  Effect.map(PgDrizzle.makeWithDefaults(), (db) => db as unknown as RelayDb.RelayDb["Service"]),
).pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.map(Config.Redacted("RELAY_DATABASE_URL"), (url) => PgClient.layer({ url })),
    ),
  ),
);

main.pipe(
  Effect.provide(
    Accounts.layer.pipe(
      Layer.provideMerge(layerDb),
      Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeCrypto.layer)),
    ),
  ),
  NodeRuntime.runMain,
);
