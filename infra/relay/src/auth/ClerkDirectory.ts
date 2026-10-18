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
  readonly banned: boolean;
}

export interface ClerkUserRef {
  readonly userId: string;
  readonly banned: boolean;
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
    ) => Effect.Effect<Option.Option<ClerkUserRef>, ClerkDirectoryUnavailable>;
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
    verifiedEmails: Effect.fn("ClerkDirectory.verifiedEmails")((userId) =>
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
            banned: user.banned,
          });
        },
        // Clerk errors can contain request details; do not export them to tracing.
        catch: () => new ClerkDirectoryUnavailable({}),
      }),
    ),
    userIdForEmail: Effect.fn("ClerkDirectory.userIdForEmail")((input) =>
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
            if (user) return Option.some({ userId: user.id, banned: user.banned });
            offset += data.length;
            if (data.length === 0 || offset >= totalCount) return Option.none<ClerkUserRef>();
          }
        },
        catch: () => new ClerkDirectoryUnavailable({}),
      }),
    ),
  });
};

const notConfigured = ClerkDirectory.of({
  configured: false,
  verifiedEmails: Effect.fn("ClerkDirectory.verifiedEmails")(() => Effect.succeedNone),
  userIdForEmail: Effect.fn("ClerkDirectory.userIdForEmail")(() => Effect.succeedNone),
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
