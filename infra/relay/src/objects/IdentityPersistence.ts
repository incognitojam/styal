import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Base64Url from "effect/encoding/Base64Url";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import {
  AccountPersistence,
  SessionPersistence,
  EmailPersistence,
} from "../persistence/IdentityPersistence.ts";
import { AccountPersistenceError, normalizeEmail } from "../auth/Accounts.ts";
import {
  AuthSessionPersistenceError,
  AUTH_SESSION_IDLE_DAYS,
  parseSessionToken,
} from "../auth/AuthSessions.ts";
import {
  generateSignInCode,
  SignInCodePersistenceError,
  SignInCodeRateLimited,
  SIGN_IN_CODE_TTL_MINUTES,
} from "../auth/EmailSignInCodes.ts";
import type { AuthSession } from "../auth/AuthSessions.ts";
import type { StoredSession } from "./AccountIdentity.ts";
import { IdentityCoordinator } from "./IdentityCoordinator.ts";
import type { IdentityBindings } from "./IdentityCoordinator.ts";
import { RPC_VERSION } from "./storage.ts";
import { emailName } from "./names.ts";
import { registrationLifecycle } from "./RegistrationLifecycle.ts";
import type { RegistrationBindings } from "./RegistrationCoordinator.ts";

const version = RPC_VERSION;
const hash = (value: string) => Base64Url.encode(sha256(utf8ToBytes(value)));
const profile = (state: { userId: string; email: string | null }) => ({
  userId: state.userId,
  email: state.email,
});
const publicSession = (s: StoredSession): AuthSession => ({
  sessionId: s.sessionId,
  userId: s.userId,
  clientId: s.clientId,
  label: s.label,
  createdAt: s.createdAt,
  lastUsedAt: s.lastUsedAt,
});

export function identityLayer(
  bindings: IdentityBindings & RegistrationBindings,
  options: { emailKey: Uint8Array; signInCodeSecret: string },
) {
  return Layer.effectContext(
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const coordinator = new IdentityCoordinator(bindings, options.emailKey);
      const removeRegistrations = yield* registrationLifecycle(bindings);
      const accountCall = <A>(
        operation: AccountPersistenceError["operation"],
        body: () => Promise<A>,
      ) =>
        Effect.tryPromise({
          try: body,
          catch: (cause) => new AccountPersistenceError({ operation, cause }),
        });
      const sessionCall = <A>(
        operation: AuthSessionPersistenceError["operation"],
        body: () => Promise<A>,
      ) =>
        Effect.tryPromise({
          try: body,
          catch: (cause) => new AuthSessionPersistenceError({ operation, cause }),
        });
      const emailCall = <A>(
        operation: SignInCodePersistenceError["operation"],
        body: () => Promise<A>,
      ) =>
        Effect.tryPromise({
          try: body,
          catch: (cause) => new SignInCodePersistenceError({ operation, cause }),
        });
      const accounts = AccountPersistence.of({
        findOrCreateByEmail: Effect.fn("relay.object_accounts.find_or_create")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const id = (yield* random.uuidV4()).replaceAll("-", "");
          const state = yield* accountCall("find-or-create", () =>
            coordinator.signup(normalizeEmail(input), `usr_${id}`, id, now, false),
          );
          if (!state) return yield* Effect.die("Account creation returned no row");
          return profile(state);
        }),
        get: Effect.fn("relay.object_accounts.get")((userId) =>
          accountCall("get", async () =>
            Option.fromNullishOr(await coordinator.read(userId)).pipe(Option.map(profile)),
          ),
        ),
        getByEmail: Effect.fn("relay.object_accounts.get_by_email")((email) =>
          accountCall("get", async () =>
            Option.fromNullishOr(await coordinator.mapped(normalizeEmail(email))).pipe(
              Option.map(profile),
            ),
          ),
        ),
        syncEmail: Effect.fn("relay.object_accounts.sync_email")(function* (userId, email) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const operationId = yield* random.uuidV4();
          return profile(
            yield* accountCall("sync-email", () =>
              coordinator.syncEmail(
                userId,
                email === null ? null : normalizeEmail(email),
                operationId,
                now,
              ),
            ),
          );
        }),
        importAccount: Effect.fn("relay.object_accounts.import")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const operationId = yield* random.uuidV4();
          return (
            (yield* accountCall("import", () =>
              coordinator.signup(normalizeEmail(input.email), input.userId, operationId, now, true),
            )) !== null
          );
        }),
      });
      const use = Effect.fn("relay.object_sessions.use")(function* (
        input: { token: string; thumbprint: string },
        revoke: boolean,
      ) {
        const parsed = parseSessionToken(input.token);
        if (!parsed) return Option.none<AuthSession>();
        const now = yield* DateTime.now;
        const userId = yield* sessionCall(revoke ? "revoke" : "authenticate", () =>
          coordinator.route(parsed.sessionId).resolve({ version }),
        );
        if (!userId) return Option.none<AuthSession>();
        const command = {
          kind: "use-session",
          sessionId: parsed.sessionId,
          tokenHash: hash(input.token),
          thumbprint: input.thumbprint,
          now: DateTime.formatIso(now),
          cutoff: DateTime.formatIso(DateTime.subtract(now, { hours: 24 })),
          expiresAt: DateTime.formatIso(DateTime.add(now, { days: AUTH_SESSION_IDLE_DAYS })),
          revoke,
        } as const;
        const result = yield* revoke
          ? removeRegistrations(userId, command)
          : sessionCall("authenticate", () => coordinator.command(userId, command));
        return "session" in result && result.session
          ? Option.some(publicSession(result.session))
          : Option.none<AuthSession>();
      });
      const sessions = SessionPersistence.of({
        create: Effect.fn("relay.object_sessions.create")(function* (input) {
          const now = yield* DateTime.now;
          const sessionId = bytesToHex(yield* random.randomBytes(16));
          const token = `styal_rt_${sessionId}_${bytesToHex(yield* random.randomBytes(32))}`;
          yield* sessionCall("create", () =>
            coordinator.openSession({
              sessionId,
              tokenHash: hash(token),
              userId: input.userId,
              clientId: input.clientId,
              thumbprint: input.thumbprint,
              label: input.label ?? null,
              createdAt: DateTime.formatIso(now),
              lastUsedAt: DateTime.formatIso(now),
              expiresAt: DateTime.formatIso(DateTime.add(now, { days: AUTH_SESSION_IDLE_DAYS })),
              published: false,
              revoked: false,
            }),
          );
          return { sessionId, token };
        }),
        authenticate: Effect.fn("relay.object_sessions.authenticate")((input) => use(input, false)),
        revokeByToken: Effect.fn("relay.object_sessions.revoke_by_token")((input) =>
          use(input, true).pipe(Effect.asVoid),
        ),
        revoke: Effect.fn("relay.object_sessions.revoke")(function* (input) {
          const result = yield* removeRegistrations(input.userId, {
            kind: "revoke-session",
            sessionId: input.sessionId,
          });
          return "revoked" in result && result.revoked === true;
        }),
        isLive: Effect.fn("relay.object_sessions.is_live")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* sessionCall("authenticate", async () => {
            const result = await coordinator.command(input.userId, {
              kind: "session",
              sessionId: input.sessionId,
            });
            return (
              "session" in result &&
              !!result.session &&
              result.session.published &&
              !result.session.revoked &&
              result.session.expiresAt > now
            );
          });
        }),
        listForUser: Effect.fn("relay.object_sessions.list")(function* (userId) {
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* sessionCall("list", async () => {
            const result = await coordinator.command(userId, { kind: "list-sessions", now });
            if (!("sessions" in result) || !result.sessions)
              throw new Error("Unexpected session list");
            return result.sessions.map(publicSession);
          });
        }),
        pruneExpired: Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const owners: string[] = [];
          yield* sessionCall("prune-expired", () =>
            coordinator.forEach("account", async (name) => {
              const stub = bindings.ACCOUNTS.getByName(name);
              // Inventory stores names, so read the durable owner before issuing an account command.
              const info = await stub.identityOwner({ version });
              if (info) owners.push(info);
            }),
          );
          yield* Effect.forEach(
            owners,
            (userId) => removeRegistrations(userId, { kind: "prune-sessions", now }),
            { concurrency: 1, discard: true },
          );
        }),
      });
      const hashCode = (codeId: string, code: string) =>
        hash(`${options.signInCodeSecret}:${codeId}:${code}`);
      const email = EmailPersistence.of({
        issue: Effect.fn("relay.object_email.issue")(function* (input) {
          const now = yield* DateTime.now;
          const codeId = (yield* random.uuidV4()).replaceAll("-", "");
          const code = input.fixedCode ?? (yield* generateSignInCode(random));
          const expiresAt = DateTime.add(now, { minutes: SIGN_IN_CODE_TTL_MINUTES });
          const retryAfter = yield* emailCall("issue", async () => {
            await coordinator.register("email", emailName(input.email, options.emailKey));
            return await coordinator.email(input.email).issue({
              version,
              code: {
                codeId,
                email: input.email,
                thumbprint: input.thumbprint,
                codeHash: hashCode(codeId, code),
                attempts: 0,
                consumedAt: null,
                createdAt: DateTime.formatIso(now),
                expiresAt: DateTime.formatIso(expiresAt),
              },
              windowStart: DateTime.formatIso(DateTime.subtract(now, { hours: 1 })),
            });
          });
          if (retryAfter !== null)
            return yield* new SignInCodeRateLimited({ retryAfterSeconds: retryAfter });
          return { codeId, code, expiresAt };
        }),
        redeem: Effect.fn("relay.object_email.redeem")(function* (input) {
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* emailCall("redeem", async () => {
            const stub = coordinator.email(input.email);
            const latest = await stub.latest({ version, thumbprint: input.thumbprint });
            if (!latest) return "expired" as const;
            return await stub.redeem({
              version,
              thumbprint: input.thumbprint,
              codeId: latest.codeId,
              codeHash: hashCode(latest.codeId, input.code),
              now,
            });
          });
        }),
        discard: Effect.fn("relay.object_email.discard")(({ email, codeId }) =>
          emailCall("discard", async () => {
            await coordinator.email(email).discard({ version, codeId });
          }),
        ),
        pruneExpired: Effect.gen(function* () {
          const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
          yield* emailCall("prune-expired", () =>
            coordinator.forEach("email", async (name) => {
              await bindings.EMAILS.getByName(name).prune({ version, cutoff });
            }),
          );
        }),
      });
      return Context.make(AccountPersistence, accounts).pipe(
        Context.add(SessionPersistence, sessions),
        Context.add(EmailPersistence, email),
      );
    }),
  );
}
