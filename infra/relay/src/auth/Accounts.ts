import { eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
    operation: Schema.Literals(["find-or-create", "get", "import", "sync-email"]),
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
    readonly getByEmail: (
      email: string,
    ) => Effect.Effect<Option.Option<Account>, AccountPersistenceError>;
    /** Clears a stale mapping if the verified primary is absent or owned by another account. */
    readonly syncEmail: (
      userId: string,
      email: string | null,
    ) => Effect.Effect<Account, AccountPersistenceError>;
    /**
     * Records an account that already exists elsewhere (a Clerk user) under its
     * existing id. Returns false when the id or the email is already taken.
     */
    readonly importAccount: (account: {
      readonly userId: string;
      readonly email: string;
    }) => Effect.Effect<boolean, AccountPersistenceError>;
  }
>()("t3code-relay/auth/Accounts") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;

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
        const userId = `usr_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
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

    getByEmail: Effect.fn("relay.accounts.get_by_email")(
      function* (email) {
        const rows = yield* db
          .select({ userId: relayUsers.userId, email: relayUsers.email })
          .from(relayUsers)
          .where(eq(relayUsers.email, normalizeEmail(email)))
          .limit(1);
        return Option.fromNullishOr(rows[0]);
      },
      Effect.mapError(
        (cause) =>
          new AccountPersistenceError({ operation: "get", cause: persistenceCause(cause) }),
      ),
    ),

    syncEmail: Effect.fn("relay.accounts.sync_email")(
      function* (userId, input) {
        const email = input === null ? null : normalizeEmail(input);
        return yield* db.$client.withTransaction(
          Effect.gen(function* () {
            let availableEmail = email;
            if (email !== null) {
              yield* db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${email}))`);
              const owner = yield* db
                .select({ userId: relayUsers.userId })
                .from(relayUsers)
                .where(eq(relayUsers.email, email))
                .limit(1);
              if (owner[0] && owner[0].userId !== userId) availableEmail = null;
            }
            const now = DateTime.formatIso(yield* DateTime.now);
            const rows = yield* db
              .insert(relayUsers)
              .values({ userId, email: availableEmail, createdAt: now, updatedAt: now })
              .onConflictDoUpdate({
                target: relayUsers.userId,
                set: { email: availableEmail, updatedAt: now },
              })
              .returning({ userId: relayUsers.userId, email: relayUsers.email });
            const row = rows[0];
            if (!row) return yield* Effect.die("relay_users email sync returned no row");
            return row;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new AccountPersistenceError({
                  operation: "sync-email",
                  cause: persistenceCause(cause),
                }),
            ),
          ),
        );
      },
      Effect.mapError(
        (cause) =>
          new AccountPersistenceError({ operation: "sync-email", cause: persistenceCause(cause) }),
      ),
    ),

    importAccount: Effect.fn("relay.accounts.import")(
      function* (account) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* db
          .insert(relayUsers)
          .values({
            userId: account.userId,
            email: normalizeEmail(account.email),
            lastSignInAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ userId: relayUsers.userId });
        return rows.length > 0;
      },
      Effect.mapError(
        (cause) =>
          new AccountPersistenceError({ operation: "import", cause: persistenceCause(cause) }),
      ),
    ),
  });
});

export const layer = Layer.effect(Accounts, make);
