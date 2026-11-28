import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import {
  AccountPersistence,
  EmailPersistence,
  ReplayPersistence,
  SessionPersistence,
} from "../persistence/IdentityPersistence.ts";

type Identity = AccountPersistence | EmailPersistence | ReplayPersistence | SessionPersistence;

const fixture = Effect.gen(function* () {
  const accounts = yield* AccountPersistence;
  const email = yield* EmailPersistence;
  const sessions = yield* SessionPersistence;
  const replay = yield* ReplayPersistence;
  const id = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  const address = `ada-${id}@example.test`;
  return { accounts, email, sessions, replay, id, address };
});

// No SQL or backend-specific state setup: another adapter supplies the same ports.
export function identityPersistenceContract<E>(
  name: string,
  layer: Layer.Layer<Identity | SecureRandom.SecureRandom, E>,
) {
  describe(name, () => {
    it.effect("agrees on one account for concurrent normalized-email sign-ins", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const accounts = yield* Effect.all(
          [
            f.accounts.findOrCreateByEmail(f.address),
            f.accounts.findOrCreateByEmail(` ${f.address.toUpperCase()} `),
          ],
          { concurrency: "unbounded" },
        );
        expect(accounts[0]).toEqual(accounts[1]);
        const account = accounts[0];
        expect(yield* f.accounts.get(account.userId)).toEqual(Option.some(account));
        expect(yield* f.accounts.getByEmail(f.address.toUpperCase())).toEqual(Option.some(account));
        expect(yield* f.accounts.get(`absent-${f.id}`)).toEqual(Option.none());
      }).pipe(Effect.provide(layer)),
    );

    it.effect("imports stable IDs and clears a conflicting email instead of stealing it", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const userId = `imported-${f.id}`;
        expect(
          yield* f.accounts.importAccount({ userId, email: ` ${f.address.toUpperCase()} ` }),
        ).toBe(true);
        expect(yield* f.accounts.importAccount({ userId: `other-${f.id}`, email: f.address })).toBe(
          false,
        );
        expect(yield* f.accounts.importAccount({ userId, email: `other-${f.address}` })).toBe(
          false,
        );
        expect((yield* f.accounts.findOrCreateByEmail(f.address)).userId).toBe(userId);
        expect(yield* f.accounts.syncEmail(`other-${f.id}`, f.address)).toEqual({
          userId: `other-${f.id}`,
          email: null,
        });
        expect(yield* f.accounts.syncEmail(userId, null)).toEqual({ userId, email: null });
        expect(yield* f.accounts.getByEmail(f.address)).toEqual(Option.none());
        expect(yield* f.accounts.syncEmail(userId, f.address.toUpperCase())).toEqual({
          userId,
          email: f.address,
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("redeems one code exactly once under concurrent requests", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = { email: f.address, thumbprint: "key-a" };
        const issued = yield* f.email.issue({ ...input, fixedCode: "12345678" });
        expect(issued.code).toBe("12345678");
        expect(yield* f.email.redeem({ ...input, thumbprint: "key-b", code: issued.code })).toBe(
          "expired",
        );
        const results = yield* Effect.all(
          [
            f.email.redeem({ ...input, code: issued.code }),
            f.email.redeem({ ...input, code: issued.code }),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.toSorted()).toEqual(["expired", "redeemed"]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("spends guesses durably and only accepts the newest unexpired code", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const input = { email: f.address, thumbprint: "key" };
        yield* f.email.issue({ ...input, fixedCode: "11111111" });
        yield* TestClock.adjust("1 second");
        yield* f.email.issue({ ...input, fixedCode: "22222222" });
        expect(yield* f.email.redeem({ ...input, code: "11111111" })).toBe("incorrect");
        const guesses = yield* Effect.all(
          Array.from({ length: 5 }, () => f.email.redeem({ ...input, code: "00000000" })),
          { concurrency: "unbounded" },
        );
        expect(guesses.filter((result) => result === "incorrect")).toHaveLength(3);
        expect(guesses.filter((result) => result === "too_many_attempts")).toHaveLength(2);
        expect(yield* f.email.redeem({ ...input, code: "22222222" })).toBe("too_many_attempts");
        yield* TestClock.adjust("1 second");
        yield* f.email.issue({ ...input, fixedCode: "33333333" });
        yield* TestClock.adjust("10 minutes");
        expect(yield* f.email.redeem({ ...input, code: "33333333" })).toBe("expired");
      }).pipe(Effect.provide(layer)),
    );

    it.effect.each([
      { keys: 1, cap: 5 },
      { keys: 6, cap: 20 },
    ])("holds concurrent issuance caps ($keys keys)", ({ keys, cap }) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const results = yield* Effect.all(
          Array.from({ length: cap + 2 }, (_, index) =>
            f.email
              .issue({ email: f.address, thumbprint: `key-${index % keys}` })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        const issued = results.filter(Result.isSuccess).map((result) => result.success);
        expect(issued).toHaveLength(cap);
        for (const result of results.filter(Result.isFailure)) {
          expect(result.failure).toMatchObject({
            _tag: "SignInCodeRateLimited",
            retryAfterSeconds: 3600,
          });
        }
        yield* f.email.discard({ email: f.address, codeId: issued[0]!.codeId });
        yield* f.email.discard({ email: f.address, codeId: issued[0]!.codeId });
        yield* f.email.issue({
          email: f.address,
          thumbprint: keys === 1 ? "key-0" : "replacement",
        });
        yield* TestClock.adjust("71 minutes");
        yield* f.email.pruneExpired;
        expect(
          yield* f.email.redeem({ email: f.address, thumbprint: "key-0", code: issued[0]!.code }),
        ).toBe("expired");
        yield* f.email.issue({ email: f.address, thumbprint: "key-0" });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("binds refresh credentials to a key and user, and revokes idempotently", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const account = yield* f.accounts.findOrCreateByEmail(f.address);
        const created = yield* f.sessions.create({
          userId: account.userId,
          clientId: "t3-mobile",
          thumbprint: "key",
          label: "Synthetic phone",
        });
        expect(created.token).toMatch(/^styal_rt_[0-9a-f]{32}_[0-9a-f]{64}$/);
        const credential = { token: created.token, thumbprint: "key" };
        expect(Option.isSome(yield* f.sessions.authenticate(credential))).toBe(true);
        expect(yield* f.sessions.authenticate({ ...credential, thumbprint: "wrong" })).toEqual(
          Option.none(),
        );
        expect(
          yield* f.sessions.authenticate({
            ...credential,
            token: `${created.token.slice(0, -1)}${created.token.endsWith("0") ? "1" : "0"}`,
          }),
        ).toEqual(Option.none());
        expect(yield* f.sessions.authenticate({ ...credential, token: "malformed" })).toEqual(
          Option.none(),
        );
        expect(
          yield* f.sessions.isLive({ userId: `other-${f.id}`, sessionId: created.sessionId }),
        ).toBe(false);
        expect(
          yield* f.sessions.revoke({ userId: `other-${f.id}`, sessionId: created.sessionId }),
        ).toBe(false);
        yield* f.sessions.revokeByToken({ ...credential, thumbprint: "wrong" });
        expect(yield* f.sessions.listForUser(account.userId)).toHaveLength(1);
        yield* f.sessions.revokeByToken(credential);
        yield* f.sessions.revokeByToken(credential);
        expect(yield* f.sessions.authenticate(credential)).toEqual(Option.none());
        expect(
          yield* f.sessions.isLive({ userId: account.userId, sessionId: created.sessionId }),
        ).toBe(false);
        expect(
          yield* f.sessions.revoke({ userId: account.userId, sessionId: created.sessionId }),
        ).toBe(false);
        expect(yield* f.sessions.listForUser(account.userId)).toEqual([]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "refreshes sliding expiry only after the use resolution and prunes expired sessions",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const account = yield* f.accounts.findOrCreateByEmail(f.address);
          const created = yield* f.sessions.create({
            userId: account.userId,
            clientId: "t3-mobile",
            thumbprint: "key",
          });
          const credential = { token: created.token, thumbprint: "key" };
          const first = Option.getOrThrow(yield* f.sessions.authenticate(credential));
          yield* TestClock.adjust("23 hours");
          expect(Option.getOrThrow(yield* f.sessions.authenticate(credential)).lastUsedAt).toBe(
            first.lastUsedAt,
          );
          yield* TestClock.adjust("2 hours");
          const refreshed = Option.getOrThrow(yield* f.sessions.authenticate(credential));
          expect(refreshed.lastUsedAt).not.toBe(first.lastUsedAt);
          yield* TestClock.adjust("89 days");
          expect(
            yield* f.sessions.isLive({ userId: account.userId, sessionId: created.sessionId }),
          ).toBe(true);
          yield* TestClock.adjust("1 day");
          expect(yield* f.sessions.authenticate(credential)).toEqual(Option.none());
          expect(yield* f.sessions.listForUser(account.userId)).toEqual([]);
          yield* f.sessions.pruneExpired;
          expect(
            yield* f.sessions.revoke({ userId: account.userId, sessionId: created.sessionId }),
          ).toBe(false);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "consumes replay identities once, retains the expiry boundary, and prunes strictly older entries",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const now = yield* DateTime.now;
          const input = { thumbprint: f.id, jti: "proof", iat: 0, expiresAt: now };
          const results = yield* Effect.all([f.replay.consume(input), f.replay.consume(input)], {
            concurrency: "unbounded",
          });
          expect(results.toSorted()).toEqual([false, true]);
          yield* f.replay.pruneExpired;
          expect(yield* f.replay.consume(input)).toBe(false);
          expect(yield* f.replay.consume({ ...input, thumbprint: `other-${f.id}` })).toBe(true);
          expect(yield* f.replay.consume({ ...input, jti: "other" })).toBe(true);
          yield* TestClock.adjust("1 millis");
          yield* f.replay.pruneExpired;
          expect(yield* f.replay.consume(input)).toBe(true);
        }).pipe(Effect.provide(layer)),
    );
  });
}
