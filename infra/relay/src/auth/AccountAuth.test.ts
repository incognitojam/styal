// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as AccountAuth from "./AccountAuth.ts";
import * as Accounts from "./Accounts.ts";
import * as AuthSessions from "./AuthSessions.ts";
import * as ClerkDirectory from "./ClerkDirectory.ts";
import * as EmailSender from "./EmailSender.ts";
import * as EmailSignInCodes from "./EmailSignInCodes.ts";
import * as RelayTokens from "./RelayTokens.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const baseConfig = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: null,
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  signInCodeSecret: Redacted.make("test-sign-in-code-secret"),
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const issuedAt = DateTime.makeUnsafe("2026-10-18T12:00:00.000Z");

interface Harness {
  readonly sent: Array<EmailSender.OutgoingEmail>;
  readonly issued: Array<{ email: string; thumbprint: string; fixedCode?: string }>;
  readonly discarded: Array<string>;
  readonly createdSessions: Array<{ userId: string; clientId: string; thumbprint: string }>;
  readonly emailLookups: Array<string>;
}

function makeLayer(input?: {
  readonly config?: Partial<RelayConfiguration.RelayConfiguration["Service"]>;
  readonly sender?: "enabled" | "disabled" | "failing";
  readonly redeem?: EmailSignInCodes.RedeemResult;
  readonly accountRow?: Accounts.Account | null;
  readonly otherAccounts?: ReadonlyArray<Accounts.Account>;
  readonly directory?: Partial<ClerkDirectory.ClerkDirectory["Service"]> | "production";
  readonly session?: AuthSessions.AuthSession | null;
}) {
  const harness: Harness = {
    sent: [],
    issued: [],
    discarded: [],
    createdSessions: [],
    emailLookups: [],
  };
  const rows = new Map<string, Accounts.Account>(
    (input?.otherAccounts ?? []).map((row) => [row.userId, row]),
  );
  if (input?.accountRow) rows.set(input.accountRow.userId, input.accountRow);
  const byEmail = (email: string) =>
    Option.fromNullishOr([...rows.values()].find((row) => row.email === email));
  const config = { ...baseConfig, ...input?.config };
  const sender =
    input?.sender === "disabled"
      ? EmailSender.layerDisabled
      : Layer.succeed(
          EmailSender.EmailSender,
          EmailSender.make((email) =>
            input?.sender === "failing"
              ? Effect.fail(new EmailSender.EmailSendFailed({ detail: "E_DAILY_LIMIT_EXCEEDED" }))
              : Effect.sync(() => {
                  harness.sent.push(email);
                }),
          ),
        );
  const layer = AccountAuth.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        RelayTokens.layer,
        sender,
        AccountAuth.layerSignInRateLimiterUnlimited,
        input?.directory === "production"
          ? ClerkDirectory.layer
          : Layer.succeed(ClerkDirectory.ClerkDirectory, {
              configured: true,
              verifiedEmails: () => Effect.succeed(Option.none()),
              userIdForEmail: () => Effect.succeed(Option.none()),
              ...input?.directory,
            }),
        Layer.mock(EmailSignInCodes.EmailSignInCodes, {
          issue: (request) =>
            Effect.sync(() => {
              harness.issued.push({ ...request });
              return {
                codeId: "code-1",
                code: request.fixedCode ?? "48291573",
                expiresAt: DateTime.add(issuedAt, { minutes: 10 }),
              };
            }),
          redeem: () => Effect.succeed(input?.redeem ?? "redeemed"),
          discard: (codeId) =>
            Effect.sync(() => {
              harness.discarded.push(codeId);
            }),
        }),
        Layer.mock(Accounts.Accounts, {
          findOrCreateByEmail: (email) =>
            Effect.sync(() => {
              const current = byEmail(email);
              if (Option.isSome(current)) return current.value;
              const account = { userId: "usr_new", email };
              rows.set(account.userId, account);
              return account;
            }),
          getByEmail: (email) => Effect.succeed(byEmail(email)),
          get: (userId) => Effect.succeed(Option.fromNullishOr(rows.get(userId))),
          syncEmail: (userId, email) =>
            Effect.sync(() => {
              const owner = email === null ? Option.none<Accounts.Account>() : byEmail(email);
              const account = {
                userId,
                email: Option.isSome(owner) && owner.value.userId !== userId ? null : email,
              };
              rows.set(userId, account);
              return account;
            }),
          importAccount: (account) =>
            Effect.sync(() => {
              rows.set(account.userId, account);
              return true;
            }),
        }),
        Layer.mock(AuthSessions.AuthSessions, {
          create: (request) =>
            Effect.sync(() => {
              harness.createdSessions.push(request);
              return { sessionId: "a".repeat(32), token: `styal_rt_${"a".repeat(32)}_secret` };
            }),
          authenticate: () => Effect.succeed(Option.fromNullishOr(input?.session ?? null)),
        }),
      ),
    ),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(NodeCryptoLayer.layer),
  );
  return { harness, layer };
}

describe("AccountAuth.startEmailSignIn", () => {
  it.effect("sends a code to the normalized address", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const started = yield* auth.startEmailSignIn({
        email: "  Someone@Example.COM ",
        thumbprint: "thumb-1",
        rateLimitKey: "203.0.113.5",
      });

      expect(harness.issued).toEqual([{ email: "someone@example.com", thumbprint: "thumb-1" }]);
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.to).toBe("someone@example.com");
      expect(harness.sent[0]?.text).toContain("48291573");
      expect(started.resendAfterSeconds).toBe(EmailSignInCodes.SIGN_IN_CODE_RESEND_AFTER_SECONDS);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the stage's fixed code only for agent test addresses", () => {
    const { harness, layer } = makeLayer({ config: { testSignInCode: "42424242" } });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      yield* auth.startEmailSignIn({
        email: "agent+relay@styal.build",
        thumbprint: "thumb-1",
        rateLimitKey: "ip",
      });
      yield* auth.startEmailSignIn({
        email: "agent+relay@example.com",
        thumbprint: "thumb-1",
        rateLimitKey: "ip",
      });

      expect(harness.issued.map((issue) => issue.fixedCode)).toEqual(["42424242", undefined]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("discards the code and reports delivery_failed when the email cannot be sent", () => {
    const { harness, layer } = makeLayer({ sender: "failing" });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const error = yield* Effect.flip(
        auth.startEmailSignIn({ email: "a@example.com", thumbprint: "t", rateLimitKey: "ip" }),
      );

      expect(error).toMatchObject({ _tag: "SignInUnavailable", reason: "delivery_failed" });
      expect(harness.discarded).toEqual(["code-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is unavailable when the deployment has no sender", () => {
    const { harness, layer } = makeLayer({ sender: "disabled" });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const error = yield* Effect.flip(
        auth.startEmailSignIn({ email: "a@example.com", thumbprint: "t", rateLimitKey: "ip" }),
      );

      expect(error).toMatchObject({ _tag: "SignInUnavailable", reason: "not_configured" });
      expect(harness.issued).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describe("AccountAuth.verifyEmailSignIn", () => {
  it.effect("opens a session whose access token carries the client's scopes and session", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const tokens = yield* RelayTokens.RelayTokens;
      const grant = yield* auth.verifyEmailSignIn({
        email: "Someone@example.com",
        code: "48291573",
        clientId: "t3-web",
        thumbprint: "thumb-1",
        rateLimitKey: "ip",
      });

      expect(grant.user).toEqual({ id: "usr_new", email: "someone@example.com" });
      expect(grant.refreshToken).toMatch(/^styal_rt_/);
      expect(harness.createdSessions).toEqual([
        { userId: "usr_new", clientId: "t3-web", thumbprint: "thumb-1" },
      ]);
      const claims = yield* tokens.verifyDpopAccessToken({
        token: grant.accessToken,
        nowEpochSeconds: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
      });
      expect(claims?.sub).toBe("usr_new");
      expect(claims?.cnf.jkt).toBe("thumb-1");
      expect(claims?.sid).toBe(grant.sessionId);
      expect(claims?.scope).toEqual(["environment:connect", "environment:status", "account"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a wrong code without creating an account or session", () => {
    const { harness, layer } = makeLayer({ redeem: "incorrect" });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const error = yield* Effect.flip(
        auth.verifyEmailSignIn({
          email: "a@example.com",
          code: "00000000",
          clientId: "t3-mobile",
          thumbprint: "t",
          rateLimitKey: "ip",
        }),
      );

      expect(error).toMatchObject({ _tag: "SignInCodeRejected", reason: "incorrect" });
      expect(harness.createdSessions).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describe("Clerk directory reconciliation", () => {
  const verify = (auth: AccountAuth.AccountAuth["Service"], email = "old@example.com") =>
    auth.verifyEmailSignIn({
      email,
      code: "12345678",
      clientId: "t3-web",
      thumbprint: "key",
      rateLimitKey: "ip",
    });

  it.effect("a native account does not depend on Clerk", () => {
    const { layer } = makeLayer({
      accountRow: { userId: "usr_native", email: "old@example.com" },
      directory: {
        verifiedEmails: () => Effect.die("must not consult Clerk"),
        userIdForEmail: () => Effect.die("must not consult Clerk"),
      },
    });
    return Effect.gen(function* () {
      const grant = yield* verify(yield* AccountAuth.AccountAuth);
      expect(grant.user.id).toBe("usr_native");
    }).pipe(Effect.provide(layer));
  });

  it.effect("an imported address still verified by Clerk keeps its id", () => {
    const { layer } = makeLayer({
      accountRow: { userId: "user_imported", email: "old@example.com" },
      directory: {
        verifiedEmails: () =>
          Effect.succeed(
            Option.some({
              primary: "new@example.com",
              all: ["old@example.com", "new@example.com"],
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      expect((yield* verify(yield* AccountAuth.AccountAuth)).user.id).toBe("user_imported");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["new@example.com", null])(
    "a removed imported address no longer signs into the Clerk account (primary %s)",
    (primary) => {
      const { layer } = makeLayer({
        accountRow: { userId: "user_imported", email: "old@example.com" },
        directory: {
          verifiedEmails: () =>
            Effect.succeed(Option.some({ primary, all: primary ? [primary] : [] })),
        },
      });
      return Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const grant = yield* verify(yield* AccountAuth.AccountAuth);
        expect(grant.user.id).toBe("usr_new");
        expect(yield* accounts.get("user_imported")).toEqual(
          Option.some({ userId: "user_imported", email: primary }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a deleted Clerk user loses its imported email mapping", () => {
    const { layer } = makeLayer({
      accountRow: { userId: "user_deleted", email: "old@example.com" },
    });
    return Effect.gen(function* () {
      expect((yield* verify(yield* AccountAuth.AccountAuth)).user.id).toBe("usr_new");
      expect(yield* (yield* Accounts.Accounts).get("user_deleted")).toEqual(
        Option.some({ userId: "user_deleted", email: null }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["user_imported", null])(
    "without a Clerk secret, imported accounts keep their mapping (existing %s)",
    (existing) => {
      const { harness, layer } = makeLayer({
        config: { clerkSecretKey: Redacted.make("") },
        directory: "production",
        accountRow: existing ? { userId: existing, email: "old@example.com" } : null,
        otherAccounts: [{ userId: "user_other", email: "other@example.com" }],
      });
      return Effect.gen(function* () {
        const grant = yield* verify(yield* AccountAuth.AccountAuth);
        const accounts = yield* Accounts.Accounts;
        expect(grant.user).toEqual({ id: existing ?? "usr_new", email: "old@example.com" });
        expect(yield* accounts.get("user_other")).toEqual(
          Option.some({ userId: "user_other", email: "other@example.com" }),
        );
        expect(harness.createdSessions.map((session) => session.userId)).toEqual([
          existing ?? "usr_new",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "does not take a new primary from another account when clearing a stale mapping",
    () => {
      const { layer } = makeLayer({
        accountRow: { userId: "user_imported", email: "old@example.com" },
        otherAccounts: [{ userId: "usr_owner", email: "new@example.com" }],
        directory: {
          verifiedEmails: () =>
            Effect.succeed(Option.some({ primary: "new@example.com", all: ["new@example.com"] })),
        },
      });
      return Effect.gen(function* () {
        expect((yield* verify(yield* AccountAuth.AccountAuth)).user.id).toBe("usr_new");
        const accounts = yield* Accounts.Accounts;
        expect(yield* accounts.get("user_imported")).toEqual(
          Option.some({ userId: "user_imported", email: null }),
        );
        expect(yield* accounts.getByEmail("new@example.com")).toEqual(
          Option.some({ userId: "usr_owner", email: "new@example.com" }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([false, true])(
    "an unmapped verified Clerk email uses the Clerk id (existing account %s)",
    (existing) => {
      const { layer } = makeLayer({
        accountRow: existing ? { userId: "user_found", email: "primary@example.com" } : null,
        directory: {
          userIdForEmail: () => Effect.succeed(Option.some("user_found")),
        },
      });
      return Effect.gen(function* () {
        expect((yield* verify(yield* AccountAuth.AccountAuth)).user).toEqual({
          id: "user_found",
          email: "old@example.com",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([false, true])(
    "a Clerk outage is retryable and opens no session (imported account %s)",
    (existing) => {
      const unavailable = () => Effect.fail(new ClerkDirectory.ClerkDirectoryUnavailable({}));
      const { harness, layer } = makeLayer({
        accountRow: existing ? { userId: "user_imported", email: "old@example.com" } : null,
        directory: { verifiedEmails: unavailable, userIdForEmail: unavailable },
      });
      return Effect.gen(function* () {
        const error = yield* Effect.flip(verify(yield* AccountAuth.AccountAuth));
        expect(error._tag).toBe("VerifiedEmailLookupFailed");
        expect(harness.createdSessions).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("Clerk exchange refreshes an existing email and clears it when Clerk has none", () => {
    const { layer } = makeLayer({
      accountRow: { userId: "user_imported", email: "old@example.com" },
    });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const base = { userId: "user_imported", clientId: "t3-web" as const, thumbprint: "key" };
      expect(
        (yield* auth.openVerifiedSession({
          ...base,
          lookupEmail: Effect.succeed(Option.some("new@example.com")),
        })).user.email,
      ).toBe("new@example.com");
      expect(
        (yield* auth.openVerifiedSession({ ...base, lookupEmail: Effect.succeed(Option.none()) }))
          .user.email,
      ).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("Clerk exchange does not claim another account's email", () => {
    const { layer } = makeLayer({
      accountRow: { userId: "usr_owner", email: "owned@example.com" },
    });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const grant = yield* auth.openVerifiedSession({
        userId: "user_imported",
        clientId: "t3-web",
        thumbprint: "key",
        lookupEmail: Effect.succeed(Option.some("owned@example.com")),
      });
      expect(grant.user).toEqual({ id: "user_imported", email: null });
      expect(yield* (yield* Accounts.Accounts).getByEmail("owned@example.com")).toEqual(
        Option.some({ userId: "usr_owner", email: "owned@example.com" }),
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("AccountAuth sessions", () => {
  it.effect("refresh fails as AuthSessionInvalid for an unknown or foreign-key session", () => {
    const { layer } = makeLayer({ session: null });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const error = yield* Effect.flip(
        auth.refresh({ refreshToken: "styal_rt_x_y", thumbprint: "t" }),
      );
      expect(error._tag).toBe("AuthSessionInvalid");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refresh issues a token for the session's own client", () => {
    const { layer } = makeLayer({
      accountRow: { userId: "user_clerk", email: "someone@example.com" },
      session: {
        sessionId: "b".repeat(32),
        userId: "user_clerk",
        clientId: "t3-cli",
        label: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        lastUsedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const grant = yield* auth.refresh({ refreshToken: "token", thumbprint: "t" });
      expect(grant.scopes).toEqual(["account"]);
      expect(grant.user).toEqual({ id: "user_clerk", email: "someone@example.com" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a Clerk exchange keeps the Clerk id and refreshes the email on every exchange", () => {
    const { harness, layer } = makeLayer({ accountRow: null });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const lookupEmail = Effect.sync(() => {
        harness.emailLookups.push("user_clerk");
        return Option.some("someone@example.com");
      });
      const first = yield* auth.openVerifiedSession({
        userId: "user_clerk",
        lookupEmail,
        clientId: "t3-mobile",
        thumbprint: "t",
      });
      yield* auth.openVerifiedSession({
        userId: "user_clerk",
        lookupEmail,
        clientId: "t3-web",
        thumbprint: "t2",
      });

      expect(first.user).toEqual({ id: "user_clerk", email: "someone@example.com" });
      expect(harness.emailLookups).toEqual(["user_clerk", "user_clerk"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("AccountAuth.openVerifiedSession", () => {
  it.effect("fails instead of opening an account without its email when the lookup fails", () => {
    const { harness, layer } = makeLayer({ accountRow: null });
    return Effect.gen(function* () {
      const auth = yield* AccountAuth.AccountAuth;
      const error = yield* Effect.flip(
        auth.openVerifiedSession({
          userId: "user_clerk",
          lookupEmail: Effect.fail(new AccountAuth.VerifiedEmailLookupFailed({})),
          clientId: "t3-web",
          thumbprint: "t",
        }),
      );
      expect(error._tag).toBe("VerifiedEmailLookupFailed");
      expect(harness.createdSessions).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describe("sign-in primitives", () => {
  it("parses only well-formed session tokens", () => {
    const sessionId = "0123456789abcdef0123456789abcdef";
    const secret = "f".repeat(64);
    expect(AuthSessions.parseSessionToken(`styal_rt_${sessionId}_${secret}`)).toEqual({
      sessionId,
      secret,
    });
    expect(AuthSessions.parseSessionToken(`styal_rt_${sessionId}_short`)).toBeNull();
    expect(AuthSessions.parseSessionToken(`t3env_${sessionId}_${secret}`)).toBeNull();
  });

  it("records session use at most once a day", () => {
    const now = DateTime.makeUnsafe("2026-10-18T12:00:00.000Z");
    expect(AuthSessions.shouldRecordUse("2026-10-18T00:00:00.000Z", now)).toBe(false);
    expect(AuthSessions.shouldRecordUse("2026-10-17T11:59:59.000Z", now)).toBe(true);
  });

  it("waits until the oldest code leaves the hourly window", () => {
    const now = DateTime.makeUnsafe("2026-10-18T12:00:00.000Z");
    expect(
      EmailSignInCodes.retryAfterSeconds(DateTime.makeUnsafe("2026-10-18T11:15:00.000Z"), now),
    ).toBe(15 * 60);
  });

  it.effect("pads small code values to eight digits", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      expect(
        yield* EmailSignInCodes.generateSignInCode({
          ...crypto,
          randomIntBetween: () => Effect.succeed(7),
        }),
      ).toBe("00000007");
    }).pipe(Effect.provide(NodeCryptoLayer.layer)),
  );

  it.effect("generates eight-digit codes, keeping leading zeros", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      for (let index = 0; index < 200; index += 1) {
        expect(yield* EmailSignInCodes.generateSignInCode(crypto)).toMatch(/^\d{8}$/);
      }
    }).pipe(Effect.provide(NodeCryptoLayer.layer)),
  );
});
