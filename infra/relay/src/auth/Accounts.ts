import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { persistenceCause } from "./persistenceCause.ts";
import { relayUsers } from "../persistence/schema.ts";

export class AccountPersistenceError extends Schema.TaggedError<AccountPersistenceError>()(
  "AccountPersistenceError",
  {
    operation: Schema.Literals(["find-or-create", "get"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Relay account '${this.operation}' failed`;
  }
}

export interface Account {
  readonly userId: string;
  readonly email: string | null;
}

/** Trim and lowercase. Provider-specific folding (dots, plus tags) is not applied. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export class Accounts extends Context.Service<
  Accounts,
  {
    /** Returns the account for the email, creating it on first sign-in. */
    readonly findOrCreateByEmail: (
      email: string,
    ) => Effect.Effect<Account, AccountPersistenceError>;
    readonly get: (
      userId: string,
    ) => Effect.Effect<Option.Option<Account>, AccountPersistenceError>;
  }
>()("t3code-relay/auth/Accounts") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const random = yield* SecureRandom.SecureRandom;

  const select = (userId: string) =>
    db
      .select({ userId: relayUsers.userId, email: relayUsers.email })
      .from(relayUsers)
      .where(eq(relayUsers.userId, userId))
      .limit(1);

  return Accounts.of({
    findOrCreateByEmail: Effect.fn("relay.accounts.find_or_create_by_email")(
      function* (input) {
        const email = normalizeEmail(input);
        const now = DateTime.formatIso(yield* DateTime.now);
        const userId = `usr_${(yield* random.uuidV4()).replaceAll("-", "")}`;
        // One statement: concurrent first sign-ins for the same email agree on
        // one id, and an existing account keeps its id (imported Clerk ids too).
        const rows = yield* db
          .insert(relayUsers)
          .values({ userId, email, lastSignInAt: now, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: relayUsers.email,
            set: { lastSignInAt: now, updatedAt: now },
          })
          .returning({ userId: relayUsers.userId, email: relayUsers.email });
        const row = rows[0];
        if (!row) {
          return yield* Effect.die("relay_users upsert returned no row");
        }
        yield* Effect.annotateCurrentSpan({ "user.id": row.userId });
        return row;
      },
      Effect.mapError(
        (cause) =>
          new AccountPersistenceError({
            operation: "find-or-create",
            cause: persistenceCause(cause),
          }),
      ),
    ),

    get: Effect.fn("relay.accounts.get")(
      function* (userId) {
        const rows = yield* select(userId);
        return Option.fromNullishOr(rows[0]);
      },
      Effect.mapError(
        (cause) =>
          new AccountPersistenceError({ operation: "get", cause: persistenceCause(cause) }),
      ),
    ),
  });
});

export const layer = Layer.effect(Accounts, make);
