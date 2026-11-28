import { disabledRegistrationCleanup } from "./registrationFixtures.ts";
import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { IdentityCoordinator } from "../IdentityCoordinator.ts";
import type { IdentityCommand, StoredSession } from "../AccountIdentity.ts";
import { accountMigrations } from "../AccountObject.ts";
import { accountName, emailName, credentialRouteName, inventoryShardName } from "../names.ts";
import { migrate } from "../storage.ts";
import { identityLayer } from "../IdentityPersistence.ts";
import { EmailPersistence, SessionPersistence } from "../../persistence/IdentityPersistence.ts";
import type { IdentityBindings } from "../IdentityCoordinator.ts";

declare global {
  namespace Cloudflare {
    interface Env extends IdentityBindings {}
  }
}
const key = new Uint8Array(32).fill(1);
const now = "2026-01-01T00:00:00.000Z";
const options = { emailKey: key, signInCodeSecret: "synthetic-code-secret" };
const hash = (s: string) => Base64Url.encode(sha256(utf8ToBytes(s)));

async function errorOf(call: () => Promise<unknown>) {
  try {
    await call();
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected failure");
}
function session(userId: string, suffix: string): { row: StoredSession; token: string } {
  const sessionId = suffix.padStart(32, "0");
  const token = `styal_rt_${sessionId}_${"a".repeat(64)}`;
  return {
    token,
    row: {
      sessionId,
      userId,
      clientId: "t3-mobile",
      label: null,
      tokenHash: hash(token),
      thumbprint: "key",
      createdAt: now,
      lastUsedAt: now,
      expiresAt: "2026-04-01T00:00:00.000Z",
      published: false,
      revoked: false,
    },
  };
}
const use = (c: IdentityCoordinator, row: StoredSession, token: string) =>
  c.command(row.userId, {
    kind: "use-session",
    sessionId: row.sessionId,
    tokenHash: hash(token),
    thumbprint: "key",
    now,
    cutoff: "2025-12-31T00:00:00.000Z",
    expiresAt: row.expiresAt,
    revoke: false,
  });

it("resumes signups after the email claim and after a lost account-write response, including restart", async () => {
  for (const stage of ["claim", "account"] as const) {
    const address = `signup-${stage}@example.test`;
    const userId = `signup-${stage}`;
    const operationId = `signup-operation-${stage}`;
    const c = new IdentityCoordinator(env, key);
    await c.register("email", emailName(address, key));
    const owner = await c
      .email(address)
      .claim({ version: 1, userId, operationId, accountEpoch: 1, signup: true });
    expect(owner?.userId).toBe(userId);
    expect(await c.mapped(address)).toBeNull();
    if (stage === "account") {
      class LostAccountResponse extends IdentityCoordinator {
        override async command(id: string, command: IdentityCommand) {
          const result = await super.command(id, command);
          if (command.kind === "create") throw new Error("Synthetic lost account response");
          return result;
        }
      }
      expect(
        await errorOf(() =>
          new LostAccountResponse(env, key).signup(address, userId, operationId, now, false),
        ),
      ).toContain("lost account response");
      expect(await c.mapped(address)).toBeNull();
    }
    await abortAllDurableObjects();
    const recovered = await new IdentityCoordinator(env, key).signup(
      address,
      userId,
      operationId,
      now,
      false,
    );
    expect(recovered).toMatchObject({ userId, email: address, pending: null });
    expect(
      (await c.signup(address, "competing-user", `competing-${stage}`, now, false))?.userId,
    ).toBe(userId);
  }
});

it("fails authorization closed until route publication confirms, retries lost replies, and never resurrects revocation", async () => {
  const c = new IdentityCoordinator(env, key);
  const userId = "session-recovery";
  await c.signup("session-recovery@example.test", userId, "signup-session", now, false);
  for (const stage of ["account", "route", "confirmed"] as const) {
    const { row, token } = session(
      userId,
      stage === "account" ? "1" : stage === "route" ? "2" : "3",
    );
    await c.command(userId, { kind: "open-session", session: { ...row, published: true } });
    if (stage !== "account") {
      await c.register("credential-route", credentialRouteName("session", row.sessionId));
      await c.route(row.sessionId).publish({ version: 1, destination: userId });
    }
    if (stage === "confirmed")
      await c.command(userId, { kind: "publish-session", sessionId: row.sessionId });
    expect(await use(c, row, token)).toMatchObject({
      session: stage === "confirmed" ? { sessionId: row.sessionId } : null,
    });
    await abortAllDurableObjects();
    await new IdentityCoordinator(env, key).openSession(row);
    expect(await use(c, row, token)).toMatchObject({ session: { sessionId: row.sessionId } });
    await c.command(userId, { kind: "revoke-session", sessionId: row.sessionId });
    expect(await use(c, row, token)).toEqual({ session: null });
    await abortAllDurableObjects();
    expect(await errorOf(() => c.openSession(row))).toContain("revoked");
    expect(await use(c, row, token)).toEqual({ session: null });
    expect(await c.route(row.sessionId).resolve({ version: 1 })).toBe(userId);
    expect(
      await errorOf(async () => {
        await c.route(row.sessionId).publish({ version: 1, destination: "different-user" });
      }),
    ).toContain("immutable");
  }
  const ref = await env.INVENTORY.getByName(
    inventoryShardName("account", accountName(userId)),
  ).list({ version: 1, kind: "account", after: "", limit: 1000 });
  expect(ref).toContainEqual({ name: accountName(userId) });
});

it("recovers email changes at every object boundary and fences old claims after reassignment", async () => {
  for (const stage of ["begin", "claim", "commit", "release", "finish"] as const) {
    const c = new IdentityCoordinator(env, key);
    const userId = `change-${stage}`;
    const old = `old-${stage}@example.test`;
    const next = `next-${stage}@example.test`;
    await c.signup(old, userId, `initial-${stage}`, now, false);
    const original = await c.email(old).resolve({ version: 1 });
    if (!original) throw new Error("Missing initial owner");
    await c.beginEmail(userId, next, `change-operation-${stage}`, now);
    const state = await c.read(userId);
    const pending = state?.pending;
    if (!pending) throw new Error("Missing email intent");
    expect(await c.mapped(old)).toBeNull();
    expect(
      await errorOf(() =>
        c.command(userId, { kind: "open-session", session: session(userId, "4").row }),
      ),
    ).toContain("pending");
    if (stage !== "begin") {
      await c.register("email", emailName(next, key));
      const owner = await c.email(next).claim({
        version: 1,
        userId,
        operationId: pending.operationId,
        accountEpoch: pending.epoch,
        signup: false,
      });
      if (!owner) throw new Error("Missing new owner");
      expect(await c.mapped(next)).toBeNull();
      if (stage !== "claim")
        await c.command(userId, {
          kind: "commit-email",
          operationId: pending.operationId,
          mapping: { ...owner, email: next },
          now,
        });
      if (stage === "release" || stage === "finish")
        await c.email(old).release({ version: 1, owner: original, now });
      if (stage === "finish")
        await c.command(userId, { kind: "finish-email", operationId: pending.operationId });
    }
    await abortAllDurableObjects();
    const recovered = await new IdentityCoordinator(env, key).recoverEmail(userId, now);
    expect(recovered).toMatchObject({ userId, email: next, pending: null });
    expect(await c.mapped(old)).toBeNull();
    expect(await c.mapped(next)).toMatchObject({ userId });
    await c.signup(old, `new-owner-${stage}`, `new-signup-${stage}`, now, false);
    await c.syncEmail(userId, null, `remove-${stage}`, now);
    await c.signup(next, `next-owner-${stage}`, `next-signup-${stage}`, now, false);
    await abortAllDurableObjects();
    // A delayed executor repeats its old claim/release/commit and the whole completed operation.
    const stale = await c.email(next).claim({
      version: 1,
      userId,
      operationId: pending.operationId,
      accountEpoch: pending.epoch,
      signup: false,
    });
    if (!stale) throw new Error("Missing retained claim result");
    expect(await c.email(next).release({ version: 1, owner: stale, now })).toBe(false);
    await c.command(userId, {
      kind: "commit-email",
      operationId: pending.operationId,
      mapping: { ...stale, email: next },
      now,
    });
    await c.syncEmail(userId, next, pending.operationId, now);
    expect(await c.mapped(next)).toMatchObject({ userId: `next-owner-${stage}` });
    expect(await c.mapped(old)).toMatchObject({ userId: `new-owner-${stage}` });
    expect(await c.read(userId)).toMatchObject({ email: null, pending: null });
  }
});

it("upgrades piece 3 storage with journal rows intact across activation", async () => {
  const stub = env.ACCOUNTS.getByName(accountName("v1-upgrade"));
  await runInDurableObject(stub, async (_instance, ctx) => {
    await ctx.storage.deleteAll();
    migrate(ctx.storage, accountMigrations.slice(0, 1));
    ctx.storage.sql.exec(
      "INSERT INTO tunnel_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "env",
      '["v1-upgrade","op"]',
      "v1-upgrade",
      "host.example.test",
      "tunnel",
      '{"kind":"release"}',
      "intent",
      "{}",
      now,
    );
  });
  await abortAllDurableObjects();
  const upgraded = env.ACCOUNTS.getByName(accountName("v1-upgrade"));
  expect(
    await upgraded.journal({ version: 1, commands: [{ kind: "pending", limit: 10 }] }),
  ).toMatchObject([
    { kind: "pending", operations: [{ operationId: '["v1-upgrade","op"]', phase: "intent" }] },
  ]);
  const inventory = await upgraded.inventory({ version: 1 });
  expect(inventory.schemaVersion).toBe(accountMigrations.length);
  expect(inventory.tables[0]?.count).toBe(1);
  await abortAllDurableObjects();
  expect(await env.ACCOUNTS.getByName(accountName("v1-upgrade")).inventory({ version: 1 })).toEqual(
    inventory,
  );
});

it.effect(
  "keeps refresh and access checks closed during publication and observes revocation on the next call",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const sessions = yield* SessionPersistence;
      const c = new IdentityCoordinator(env, key);
      yield* Effect.promise(() =>
        c.signup("auth-publication@example.test", "auth-publication", "auth-signup", now, false),
      );
      const { row, token } = session("auth-publication", "5");
      const credential = { token, thumbprint: "key" };
      const input = { userId: row.userId, sessionId: row.sessionId };
      yield* Effect.promise(() => c.command(row.userId, { kind: "open-session", session: row }));
      expect(yield* sessions.authenticate(credential)).toEqual(Option.none());
      expect(yield* sessions.isLive(input)).toBe(false);
      yield* Effect.promise(async () => {
        await c.register("credential-route", credentialRouteName("session", row.sessionId));
        await c.route(row.sessionId).publish({ version: 1, destination: row.userId });
      });
      expect(yield* sessions.authenticate(credential)).toEqual(Option.none());
      expect(yield* sessions.isLive(input)).toBe(false);
      yield* Effect.promise(() => abortAllDurableObjects());
      yield* Effect.promise(() => c.publishSession(row.userId, row.sessionId));
      expect(Option.isSome(yield* sessions.authenticate(credential))).toBe(true);
      expect(yield* sessions.isLive(input)).toBe(true);
      yield* sessions.revoke(input);
      expect(yield* sessions.authenticate(credential)).toEqual(Option.none());
      expect(yield* sessions.isLive(input)).toBe(false);
    }).pipe(
      Effect.provide(
        identityLayer(env, options).pipe(
          Layer.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, disabledRegistrationCleanup)),
        ),
      ),
    ),
);

it("retains issuance identity across lost replies and restarts without restoring discarded or consumed codes", async () => {
  const c = new IdentityCoordinator(env, key);
  const address = "code-retry@example.test";
  await c.register("email", emailName(address, key));
  const code = {
    codeId: "retry-code",
    email: address,
    thumbprint: "key",
    codeHash: "prepared-hash",
    attempts: 0,
    consumedAt: null,
    createdAt: now,
    expiresAt: "2026-01-01T00:10:00.000Z",
  };
  const request = { version: 1, code, windowStart: "2025-12-31T23:00:00.000Z" };
  await c.email(address).issue(request);
  const snapshot = await c.email(address).inventory({ version: 1 });
  await abortAllDurableObjects();
  await c.email(address).issue(request);
  expect(await c.email(address).inventory({ version: 1 })).toEqual(snapshot);
  const redeem = {
    version: 1,
    thumbprint: "key",
    codeId: code.codeId,
    codeHash: code.codeHash,
    now,
  };
  expect(await c.email(address).redeem(redeem)).toBe("redeemed");
  await abortAllDurableObjects();
  await c.email(address).issue(request);
  expect(await c.email(address).redeem(redeem)).toBe("expired");
  await c.email(address).discard({ version: 1, codeId: code.codeId });
  await abortAllDurableObjects();
  await c.email(address).issue(request);
  expect(await c.email(address).latest({ version: 1, thumbprint: "key" })).toBeNull();
  const owner = await c.email(address).claim({
    version: 1,
    userId: "code-owner",
    operationId: "code-owner-op",
    accountEpoch: 1,
    signup: true,
  });
  if (!owner) throw new Error("Missing owner");
  const other = { ...code, codeId: "before-release" };
  await c.email(address).issue({ ...request, code: other });
  await c.email(address).release({ version: 1, owner, now });
  await c.email(address).claim({
    version: 1,
    userId: "new-code-owner",
    operationId: "new-code-owner-op",
    accountEpoch: 1,
    signup: true,
  });
  expect(await c.email(address).redeem({ ...redeem, codeId: other.codeId })).toBe("expired");
  for (const disposition of ["consumed", "discarded"] as const) {
    const email = `prune-${disposition}@example.test`;
    const issued = { ...code, email, codeId: `prune-${disposition}` };
    await c.register("email", emailName(email, key));
    await c.email(email).issue({ ...request, code: issued });
    if (disposition === "consumed") {
      expect(await c.email(email).redeem({ ...redeem, codeId: issued.codeId })).toBe("redeemed");
    } else {
      await c.email(email).discard({ version: 1, codeId: issued.codeId });
    }
    await c.email(email).prune({ version: 1, cutoff: code.expiresAt });
    const counts = async () =>
      (await c.email(email).inventory({ version: 1 })).tables.map(({ table, count }) => ({
        table,
        count,
      }));
    const empty = [
      { table: "email_owner", count: 1 },
      { table: "code_issuance", count: 0 },
      { table: "email_claims", count: 0 },
      { table: "relay_email_sign_in_codes", count: 0 },
    ];
    expect(await counts()).toEqual(empty);
    await abortAllDurableObjects();
    // Even an arbitrarily late copy of the original RPC must not recreate pruned state.
    await c.email(email).issue({ ...request, code: issued });
    expect(await counts()).toEqual(empty);
    expect(await c.email(email).latest({ version: 1, thumbprint: "key" })).toBeNull();
  }
});

it("keeps one owner when imports race for the same ID or address, and preserves session refresh on create retry", async () => {
  const c = new IdentityCoordinator(env, key);
  const sameId = await Promise.all([
    c.signup("import-a@example.test", "same-import", "import-a", now, true),
    c.signup("import-b@example.test", "same-import", "import-b", now, true),
  ]);
  expect(sameId.filter(Boolean)).toHaveLength(1);
  expect(
    [await c.mapped("import-a@example.test"), await c.mapped("import-b@example.test")].filter(
      Boolean,
    ),
  ).toHaveLength(1);
  const sameEmail = await Promise.all([
    c.signup("same-import@example.test", "import-owner-a", "owner-a", now, true),
    c.signup("same-import@example.test", "import-owner-b", "owner-b", now, true),
  ]);
  expect(sameEmail.filter(Boolean)).toHaveLength(1);
  const { row, token } = session("same-import", "6");
  await c.openSession(row);
  await c.command(row.userId, {
    kind: "use-session",
    sessionId: row.sessionId,
    tokenHash: hash(token),
    thumbprint: "key",
    now: "2026-01-03T00:00:00.000Z",
    cutoff: "2026-01-02T00:00:00.000Z",
    expiresAt: "2026-04-03T00:00:00.000Z",
    revoke: false,
  });
  await abortAllDurableObjects();
  await c.openSession(row);
  expect(await c.command(row.userId, { kind: "session", sessionId: row.sessionId })).toMatchObject({
    session: { lastUsedAt: "2026-01-03T00:00:00.000Z", expiresAt: "2026-04-03T00:00:00.000Z" },
  });
});

it("rejects pending session publication after an email epoch changes, preserving already published sessions", async () => {
  const c = new IdentityCoordinator(env, key);
  const userId = "publication-epoch";
  await c.signup("publication-epoch@example.test", userId, "epoch-initial", now, false);
  const live = session(userId, "7");
  await c.openSession(live.row);
  for (const stage of ["pending", "complete"] as const) {
    const { row, token } = session(userId, stage === "pending" ? "8" : "9");
    await c.command(userId, { kind: "open-session", session: row });
    await c.beginEmail(userId, `epoch-${stage}@example.test`, `epoch-change-${stage}`, now);
    if (stage === "complete") await c.recoverEmail(userId, now);
    await abortAllDurableObjects();
    expect(await errorOf(() => c.publishSession(userId, row.sessionId))).toContain("revoked");
    expect(await use(c, row, token)).toEqual({ session: null });
    expect(await use(c, live.row, live.token)).toMatchObject({
      session: { sessionId: live.row.sessionId },
    });
    await c.recoverEmail(userId, now);
  }
});

it("releases a losing import claim after a lost account-write response and retry", async () => {
  const c = new IdentityCoordinator(env, key);
  const userId = "losing-import";
  const losingEmail = "losing-import@example.test";
  // Both imports have observed the absent account; the loser is paused before its account write.
  await c.register("email", emailName(losingEmail, key));
  await c
    .email(losingEmail)
    .claim({ version: 1, userId, accountEpoch: 1, operationId: "losing-operation", signup: false });
  await c.signup("winning-import@example.test", userId, "winning-operation", now, true);
  await abortAllDurableObjects();
  expect(await c.signup(losingEmail, userId, "losing-operation", now, true)).toBeNull();
  expect(await c.email(losingEmail).resolve({ version: 1 })).toBeNull();
  expect(
    await c.signup(losingEmail, "replacement-import", "replacement-operation", now, false),
  ).toMatchObject({ userId: "replacement-import" });
});

it.effect("discards a failed delivery in its email object while inventory is unavailable", () =>
  Effect.gen(function* () {
    const c = new IdentityCoordinator(env, key);
    const email = "discard-route@example.test";
    const codeId = "discard-route-code";
    yield* Effect.promise(async () => {
      await c.register("email", emailName(email, key));
      await c.email(email).issue({
        version: 1,
        windowStart: "2025-12-31T23:00:00.000Z",
        code: {
          codeId,
          email,
          thumbprint: "key",
          codeHash: "synthetic-hash",
          attempts: 0,
          consumedAt: null,
          createdAt: now,
          expiresAt: "2026-01-01T00:10:00.000Z",
        },
      });
    });
    const blockedInventory = new Proxy(env.INVENTORY, {
      get() {
        throw new Error("Synthetic inventory outage");
      },
    });
    const codes = yield* EmailPersistence.pipe(
      Effect.provide(identityLayer({ ...env, INVENTORY: blockedInventory }, options)),
    );
    yield* codes.discard({ email, codeId });
    expect(
      yield* Effect.promise(() => c.email(email).latest({ version: 1, thumbprint: "key" })),
    ).toBeNull();
  }).pipe(Effect.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, disabledRegistrationCleanup))),
);
