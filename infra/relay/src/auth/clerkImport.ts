import * as Schema from "effect/Schema";

import { normalizeEmail } from "./Accounts.ts";

// The fields of Clerk's Backend API user object that the import reads.
export const ClerkUser = Schema.Struct({
  id: Schema.String,
  primary_email_address_id: Schema.NullOr(Schema.String),
  email_addresses: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      email_address: Schema.String,
      verification: Schema.NullOr(Schema.Struct({ status: Schema.String })),
    }),
  ),
});
export type ClerkUser = typeof ClerkUser.Type;

/**
 * The address a Clerk user signs in with by email after the migration: the
 * primary address when verified, otherwise the first verified one. Null when
 * the user has no verified address.
 */
export function clerkUserEmail(user: ClerkUser): string | null {
  const verified = user.email_addresses.filter(
    (address) => address.verification?.status === "verified",
  );
  const chosen =
    verified.find((address) => address.id === user.primary_email_address_id) ?? verified[0];
  return chosen ? normalizeEmail(chosen.email_address) : null;
}
