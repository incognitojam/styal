import { createClerkClient } from "@clerk/backend";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import { normalizeEmail } from "./Accounts.ts";

export class ClerkDirectoryUnavailable extends Schema.TaggedError<ClerkDirectoryUnavailable>()(
  "ClerkDirectoryUnavailable",
  {},
) {
  override get message(): string {
    return "Clerk's verified email directory is unavailable";
  }
}

export interface VerifiedEmails {
  readonly primary: string | null;
  readonly all: ReadonlyArray<string>;
}

export class ClerkDirectory extends Context.Service<
  ClerkDirectory,
  {
    /**
     * False when the relay has no Clerk secret. The lookups then return None
     * without asking Clerk, so None does not mean the user was deleted; callers
     * must keep stored Clerk mappings instead of treating them as stale.
     */
    readonly configured: boolean;
    /** None only when Clerk confirms the user no longer exists. */
    readonly verifiedEmails: (
      userId: string,
    ) => Effect.Effect<Option.Option<VerifiedEmails>, ClerkDirectoryUnavailable>;
    readonly userIdForEmail: (
      email: string,
    ) => Effect.Effect<Option.Option<string>, ClerkDirectoryUnavailable>;
  }
>()("t3code-relay/auth/ClerkDirectory") {}

export const make = (
  config: Pick<
    RelayConfiguration.RelayConfiguration["Service"],
    "clerkSecretKey" | "clerkPublishableKey"
  >,
) => {
  const client = () =>
    createClerkClient({
      secretKey: Redacted.value(config.clerkSecretKey),
      publishableKey: config.clerkPublishableKey,
    });
  return ClerkDirectory.of({
    configured: true,
    verifiedEmails: (userId) =>
      Effect.tryPromise({
        try: async () => {
          let user;
          try {
            user = await client().users.getUser(userId);
          } catch (cause) {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "status" in cause &&
              cause.status === 404
            ) {
              return Option.none<VerifiedEmails>();
            }
            throw cause;
          }
          const verified = user.emailAddresses.filter(
            (address) => address.verification?.status === "verified",
          );
          const primary =
            verified.find((address) => address.id === user.primaryEmailAddressId) ?? verified[0];
          return Option.some({
            primary: primary ? normalizeEmail(primary.emailAddress) : null,
            all: verified.map((address) => normalizeEmail(address.emailAddress)),
          });
        },
        // Clerk errors can contain request details; do not export them to tracing.
        catch: () => new ClerkDirectoryUnavailable({}),
      }),
    userIdForEmail: (input) =>
      Effect.tryPromise({
        try: async () => {
          const email = normalizeEmail(input);
          // The API filter includes unverified addresses. Check exact verified
          // ownership ourselves, including secondary addresses and pagination.
          let offset = 0;
          const limit = 100;
          while (true) {
            const { data, totalCount } = await client().users.getUserList({
              emailAddress: [email],
              limit,
              offset,
            });
            const user = data.find((candidate) =>
              candidate.emailAddresses.some(
                (address) =>
                  address.verification?.status === "verified" &&
                  normalizeEmail(address.emailAddress) === email,
              ),
            );
            if (user) return Option.some(user.id);
            offset += data.length;
            if (data.length === 0 || offset >= totalCount) return Option.none<string>();
          }
        },
        catch: () => new ClerkDirectoryUnavailable({}),
      }),
  });
};

const notConfigured = ClerkDirectory.of({
  configured: false,
  verifiedEmails: () => Effect.succeed(Option.none()),
  userIdForEmail: () => Effect.succeed(Option.none()),
});

/** For isolated tests with no Clerk identities. */
export const layerDisabled = Layer.succeed(ClerkDirectory, notConfigured);

/** A relay without a Clerk secret has no Clerk identities to consult. */
export const layer = Layer.effect(
  ClerkDirectory,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    return Redacted.value(config.clerkSecretKey).trim() === "" ? notConfigured : make(config);
  }),
);
