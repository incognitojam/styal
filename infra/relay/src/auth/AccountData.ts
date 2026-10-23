import { eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import * as LiveActivityCleanup from "../agentActivity/LiveActivityCleanup.ts";
import {
  relayAuthSessions,
  relayAgentActivityRows,
  relayDeliveryAttempts,
  relayEmailSignInCodes,
  relayEnvironmentLinks,
  relayLiveActivities,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
  relayMobileDevices,
  relayUsers,
} from "../persistence/schema.ts";
import { persistenceCause } from "./persistenceCause.ts";

export class AccountDataDeletePersistenceError extends Schema.TaggedError<AccountDataDeletePersistenceError>()(
  "AccountDataDeletePersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Relay account data could not be deleted";
  }
}

/**
 * Removes every row the relay keeps for an account. Callers unlink the
 * account's environments first, so their tunnels are torn down before the
 * allocation rows that track them go.
 */
export class AccountData extends Context.Service<
  AccountData,
  {
    /** Includes revoked links and allocations left behind by failed unlinks. */
    readonly listEnvironmentIds: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<string>, AccountDataDeletePersistenceError>;
    readonly deleteForUser: (input: {
      readonly userId: string;
      readonly email: string | null;
    }) => Effect.Effect<void, AccountDataDeletePersistenceError>;
  }
>()("t3code-relay/auth/AccountData") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const cleanup = yield* LiveActivityCleanup.make;
  return AccountData.of({
    listEnvironmentIds: Effect.fn("relay.account_data.list_environment_ids")(
      function* (userId) {
        const links = db
          .select({ environmentId: relayEnvironmentLinks.environmentId })
          .from(relayEnvironmentLinks)
          .where(eq(relayEnvironmentLinks.userId, userId));
        const allocations = db
          .select({ environmentId: relayManagedEndpointAllocations.environmentId })
          .from(relayManagedEndpointAllocations)
          .where(eq(relayManagedEndpointAllocations.userId, userId));
        return (yield* links.union(allocations)).map((row) => row.environmentId);
      },
      Effect.mapError(
        (cause) => new AccountDataDeletePersistenceError({ cause: persistenceCause(cause) }),
      ),
    ),
    deleteForUser: Effect.fn("relay.account_data.delete_for_user")(
      function* (input) {
        yield* cleanup.removeAfterEnds(eq(relayMobileDevices.userId, input.userId), (confirm) =>
          db.$client.withTransaction(
            Effect.gen(function* () {
              const outstanding = yield* db
                .select()
                .from(relayManagedEndpointAllocations)
                .where(eq(relayManagedEndpointAllocations.userId, input.userId))
                .limit(1);
              if (outstanding.length > 0) {
                return yield* new AccountDataDeletePersistenceError({
                  cause: "Managed endpoint teardown is incomplete",
                });
              }
              // Sessions first: registration and session revocation lock the
              // session row before device and Live Activity rows, so taking them
              // in the same order cannot deadlock. Deleting them also stops new
              // session-bound registrations before `confirm` checks the ends.
              yield* db.delete(relayAuthSessions).where(eq(relayAuthSessions.userId, input.userId));
              yield* confirm;
              yield* db
                .delete(relayLiveActivities)
                .where(eq(relayLiveActivities.userId, input.userId));
              yield* db
                .delete(relayMobileDevices)
                .where(eq(relayMobileDevices.userId, input.userId));
              yield* db
                .delete(relayDeliveryAttempts)
                .where(eq(relayDeliveryAttempts.userId, input.userId));
              // Links may already be revoked by teardown, but still identify the
              // activity pairs this account owned. Another active owner keeps them.
              yield* db.delete(relayAgentActivityRows).where(sql`
              exists (
                select 1 from ${relayEnvironmentLinks} owned
                where owned.user_id = ${input.userId}
                  and owned.environment_id = ${relayAgentActivityRows.environmentId}
                  and owned.environment_public_key = ${relayAgentActivityRows.environmentPublicKey}
              ) and not exists (
                select 1 from ${relayEnvironmentLinks} other
                where other.user_id <> ${input.userId} and other.revoked_at is null
                  and other.environment_id = ${relayAgentActivityRows.environmentId}
                  and other.environment_public_key = ${relayAgentActivityRows.environmentPublicKey}
              )
            `);
              yield* db
                .delete(relayEnvironmentLinks)
                .where(eq(relayEnvironmentLinks.userId, input.userId));
              yield* db
                .delete(relayManagedTunnelLimits)
                .where(eq(relayManagedTunnelLimits.userId, input.userId));
              if (input.email !== null) {
                yield* db
                  .delete(relayEmailSignInCodes)
                  .where(eq(relayEmailSignInCodes.email, input.email));
              }
              yield* db.delete(relayUsers).where(eq(relayUsers.userId, input.userId));
            }),
          ),
        );
      },
      Effect.mapError(
        (cause) => new AccountDataDeletePersistenceError({ cause: persistenceCause(cause) }),
      ),
    ),
  });
});

export const layer = Layer.effect(AccountData, make);
