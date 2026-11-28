import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AccountPersistence } from "../persistence/IdentityPersistence.ts";

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

export const layer = Layer.effect(
  Accounts,
  Effect.map(AccountPersistence, (store) => Accounts.of(store)),
);
