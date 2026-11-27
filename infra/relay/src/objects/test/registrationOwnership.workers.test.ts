import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { RegistrationCoordinator } from "../RegistrationCoordinator.ts";
import type { RegistrationBindings } from "../RegistrationCoordinator.ts";
import type { PushTokenObject } from "../PushTokenObject.ts";
import { identity } from "../AccountIdentity.ts";
import { IdentityCoordinator } from "../IdentityCoordinator.ts";
import { accountMigrations } from "../AccountObject.ts";
import { accountName, pushTokenName, inventoryShardName } from "../names.ts";
import { migrate, RPC_VERSION as version } from "../storage.ts";
import { resetRegistrationObjects, namespaceWith } from "./resetRegistrationObjects.ts";

declare global {
  namespace Cloudflare {
    interface Env extends RegistrationBindings {
      PUSH_TOKENS: DurableObjectNamespace<PushTokenObject>;
    }
  }
}

function milestone() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const now = "2026-01-01T00:00:00.000Z";
const options = { emailKey: new Uint8Array(32).fill(1), signInCodeSecret: "synthetic-code-secret" };
const registration = (
  deviceId: string,
  pushToken = "shared-push",
): RelayDeviceRegistrationRequest => ({
  deviceId,
  label: "Synthetic phone",
  platform: "ios",
  pushToken,
  pushToStartToken: `start-${deviceId}`,
  bundleId: "test.example.phone",
  apsEnvironment: "sandbox",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
    attendedAlertDelaySeconds: 90,
  },
});
const deviceInput = (deviceId: string, pushToken = "shared-push") => ({
  kind: "device" as const,
  registration: registration(deviceId, pushToken),
});

async function sessionOwner() {
  const userId = "account-session";
  const id = new IdentityCoordinator(env, options.emailKey);
  await id.signup("session@example.test", userId, "create-session-owner", now, false);
  await id.openSession({
    sessionId: "session-a",
    userId,
    tokenHash: "synthetic-hash",
    thumbprint: "session-key",
    clientId: "t3-mobile",
    label: null,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: "2026-04-01T00:00:00.000Z",
    published: false,
    revoked: false,
  });
  return { userId, sessionId: "session-a" };
}

function loseReadyOnce() {
  let lose = true;
  return {
    ...env,
    ACCOUNTS: namespaceWith(env.ACCOUNTS, (name: string) => {
      const stub = env.ACCOUNTS.getByName(name);
      return new Proxy(stub, {
        get(target, method) {
          if (method === "registrations")
            return async (request: Parameters<typeof stub.registrations>[0]) => {
              const result = await stub.registrations(request);
              if (lose && request.command.kind === "ready") {
                lose = false;
                throw new Error("Synthetic lost ready response");
              }
              return result;
            };
          return Reflect.get(target, method, target);
        },
      });
    }),
  };
}

it.each(["revoke", "expire"] as const)(
  "ends session registrations inside a direct account %s transition",
  async (operation) => {
    await resetRegistrationObjects();
    const owner = await sessionOwner();
    const c = new RegistrationCoordinator(env);
    expect(
      await env.PUSH_TOKENS.getByName(pushTokenName("push", "shared-push")).read({ version }),
    ).toMatchObject({ generation: 0, initialized: false });
    await c.register(
      owner.userId,
      { ...deviceInput("phone-a"), sessionId: owner.sessionId },
      "phone",
      now,
    );
    await c.register(
      owner.userId,
      {
        kind: "activity",
        sessionId: owner.sessionId,
        registration: { deviceId: "phone-a", activityPushToken: "card-a" },
      },
      "card",
      now,
    );
    await c.register(owner.userId, deviceInput("legacy", "legacy-push"), "legacy", now);
    await abortAllDurableObjects();
    const account = () => env.ACCOUNTS.getByName(accountName(owner.userId));
    const result = await account().identity({
      version,
      userId: owner.userId,
      command:
        operation === "revoke"
          ? { kind: "revoke-session", sessionId: owner.sessionId }
          : { kind: "prune-sessions", now: "2026-04-01T00:00:00.000Z" },
    });
    if (operation === "revoke") expect(result).toMatchObject({ revoked: true });
    await abortAllDurableObjects();
    expect((await c.snapshot(owner.userId, now)).records.map((row) => row.deviceId)).toEqual([
      "legacy",
    ]);
    expect(
      await account().identity({
        version,
        userId: owner.userId,
        command: { kind: "session", sessionId: owner.sessionId },
      }),
    ).toMatchObject({ session: { revoked: true } });
  },
);

it("requires recovery before revoking a registration with an unsettled claim", async () => {
  await resetRegistrationObjects();
  const owner = await sessionOwner();
  const c = new RegistrationCoordinator(env);
  await c.register("old-account", deviceInput("old-phone"), "old-registration", now);
  const input = { ...deviceInput("phone-a"), sessionId: owner.sessionId };
  await expect(
    new RegistrationCoordinator(loseReadyOnce()).register(owner.userId, input, "pending", now),
  ).rejects.toThrow("Synthetic lost ready");
  await abortAllDurableObjects();
  expect(
    await env.ACCOUNTS.getByName(accountName(owner.userId)).identity({
      version,
      userId: owner.userId,
      command: { kind: "revoke-session", sessionId: owner.sessionId },
    }),
  ).toEqual({ registrationPending: true });
  expect((await c.views("old-account", now))[0]!.candidate.device!.push?.token).toBe("shared-push");
  await c.settle(owner.userId, "phone-a", now);
  expect((await c.views(owner.userId, now))[0]!.candidate.device!.push?.token).toBe("shared-push");
  expect(
    await env.ACCOUNTS.getByName(accountName(owner.userId)).identity({
      version,
      userId: owner.userId,
      command: { kind: "revoke-session", sessionId: owner.sessionId },
    }),
  ).toMatchObject({ revoked: true });
  expect((await c.views(owner.userId, now)).filter((row) => row.candidate.device)).toEqual([]);
});

it("fences an expired pending claim across lost fence responses and restart", async () => {
  await resetRegistrationObjects();
  const owner = await sessionOwner();
  const c = new RegistrationCoordinator(env);
  await c.register("old-account", deviceInput("old-phone"), "old-registration", now);
  const input = { ...deviceInput("phone-a"), sessionId: owner.sessionId };
  await expect(
    new RegistrationCoordinator(loseReadyOnce()).register(owner.userId, input, "pending", now),
  ).rejects.toThrow("Synthetic lost ready");
  const pending = (await c.snapshot(owner.userId, now)).records[0]!.pending!;
  const claim = pending.claims.find((row) => row.reference.kind === "push")!;
  await abortAllDurableObjects();
  let lose = true;
  const interrupted = new RegistrationCoordinator({
    ...env,
    PUSH_TOKENS: {
      getByName(name: string) {
        const stub = env.PUSH_TOKENS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "fence")
              return async (request: Parameters<typeof stub.fence>[0]) => {
                const result = await stub.fence(request);
                if (lose) {
                  lose = false;
                  throw new Error("Synthetic lost fence response");
                }
                return result;
              };
            return Reflect.get(target, method, target);
          },
        });
      },
    },
  });
  const expired = "2026-04-01T00:00:00.000Z";
  await expect(interrupted.settle(owner.userId, "phone-a", expired)).rejects.toThrow(
    "Synthetic lost fence",
  );
  await abortAllDurableObjects();
  await c.settle(owner.userId, "phone-a", expired);
  expect((await c.snapshot(owner.userId, expired)).records[0]?.pending).toBeNull();
  expect(
    await env.PUSH_TOKENS.getByName(pushTokenName("push", "shared-push")).transfer({
      version,
      ...claim,
      now: expired,
    }),
  ).toEqual({ applied: false });
  expect((await c.views("old-account", expired))[0]!.candidate.device!.push?.token).toBe(
    "shared-push",
  );
});

it.each(["one-account", "two-accounts"])(
  "keeps one owner under concurrent token registrations in %s",
  async (mode) => {
    await resetRegistrationObjects();
    const c = new RegistrationCoordinator(env);
    const b = mode === "one-account" ? "account-a" : "account-b";
    await Promise.all([
      c.register("account-a", deviceInput("phone-a"), "register-a", now),
      c.register(b, deviceInput("phone-b"), "register-b", now),
    ]);
    const views = [
      ...(await c.views("account-a", now)),
      ...(b === "account-a" ? [] : await c.views(b, now)),
    ];
    expect(views).toHaveLength(2);
    expect(views.filter((row) => row.candidate.device?.push?.token === "shared-push")).toHaveLength(
      1,
    );
    expect(views.every((row) => row.candidate.device?.start)).toBe(true);
    await Promise.all([
      c.register(
        "account-a",
        {
          kind: "activity",
          registration: { deviceId: "phone-a", activityPushToken: "shared-card" },
        },
        "card-a",
        now,
      ),
      c.register(
        b,
        {
          kind: "activity",
          registration: { deviceId: "phone-b", activityPushToken: "shared-card" },
        },
        "card-b",
        now,
      ),
    ]);
    await abortAllDurableObjects();
    const after = [
      ...(await c.views("account-a", now)),
      ...(b === "account-a" ? [] : await c.views(b, now)),
    ];
    expect(
      after.filter((row) => row.candidate.activity?.token?.token === "shared-card"),
    ).toHaveLength(1);
    const owner = await env.PUSH_TOKENS.getByName(
      pushTokenName("live-activity", "shared-card"),
    ).read({ version });
    expect(owner.owner).toBeTruthy();
  },
);

it("never steals a moved token back with an old claim or clears its later owner", async () => {
  await resetRegistrationObjects();
  const c = new RegistrationCoordinator(env);
  await c.register("account-a", deviceInput("phone-a"), "original", now);
  const original = (await c.views("account-a", now))[0]!.candidate.device!.push!;
  await c.register("account-b", deviceInput("phone-b"), "replacement", now);
  await abortAllDurableObjects();
  const token = env.PUSH_TOKENS.getByName(pushTokenName("push", "shared-push"));
  expect(
    await token.transfer({ version, reference: original, expected: original.generation - 1, now }),
  ).toEqual({ applied: true });
  expect(await token.status({ version, reference: original })).toEqual({
    live: false,
    lostAt: now,
  });
  expect(await token.clear({ version, reference: original, now })).toBe(false);
  expect((await c.views("account-a", now))[0]!.candidate.device!.push).toBeNull();
  expect((await c.views("account-b", now))[0]!.candidate.device!.push?.token).toBe("shared-push");
});

it.each(["begin", "ready", "transfer", "finish"] as const)(
  "recovers a lost %s response after object restart",
  async (phase) => {
    await resetRegistrationObjects();
    let lose = true;
    const bindings = {
      ...env,
      ACCOUNTS: namespaceWith(env.ACCOUNTS, (name: string) => {
        const stub = env.ACCOUNTS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "registrations")
              return async (request: Parameters<typeof stub.registrations>[0]) => {
                const result = await stub.registrations(request);
                if (lose && request.command.kind === phase) {
                  lose = false;
                  throw new Error("Synthetic lost account response");
                }
                return result;
              };
            return Reflect.get(target, method, target);
          },
        });
      }),
      PUSH_TOKENS: {
        getByName(name: string) {
          const stub = env.PUSH_TOKENS.getByName(name);
          return new Proxy(stub, {
            get(target, method) {
              if (method === "transfer")
                return async (request: Parameters<typeof stub.transfer>[0]) => {
                  const result = await stub.transfer(request);
                  if (lose && phase === "transfer") {
                    lose = false;
                    throw new Error("Synthetic lost token response");
                  }
                  return result;
                };
              return Reflect.get(target, method, target);
            },
          });
        },
      },
    };
    const interrupted = new RegistrationCoordinator(bindings);
    await expect(
      interrupted.register("account-a", deviceInput("phone-a"), "original", now),
    ).rejects.toThrow("Synthetic lost");
    await abortAllDurableObjects();
    const c = new RegistrationCoordinator(env);
    await c.register("account-a", deviceInput("phone-a"), "retry", now);
    const record = (await c.snapshot("account-a", now)).records[0]!;
    expect(record.pending).toBeNull();
    expect((await c.views("account-a", now))[0]!.candidate.device?.push?.token).toBe("shared-push");
    const before = await env.PUSH_TOKENS.getByName(pushTokenName("push", "shared-push")).inventory({
      version,
    });
    await c.register("account-a", deviceInput("phone-a"), "identical", now);
    expect(
      await env.PUSH_TOKENS.getByName(pushTokenName("push", "shared-push")).inventory({ version }),
    ).toEqual(before);
  },
);

it("keeps the working registration when preflight fails and releases its uncommitted intent", async () => {
  await resetRegistrationObjects();
  const c = new RegistrationCoordinator(env);
  await c.register("account-a", deviceInput("phone-a"), "original", now);
  const blocked = new RegistrationCoordinator({
    ...env,
    INVENTORY: namespaceWith(env.INVENTORY, () => {
      throw new Error("Synthetic inventory outage");
    }),
  });
  await expect(
    blocked.register("account-a", deviceInput("phone-a", "new-push"), "failed", now),
  ).rejects.toThrow("Synthetic inventory outage");
  expect((await c.snapshot("account-a", now)).records[0]?.pending).toBeNull();
  expect((await c.views("account-a", now))[0]!.candidate.device!.push?.token).toBe("shared-push");
  expect(
    (await env.PUSH_TOKENS.getByName(pushTokenName("push", "new-push")).inventory({ version }))
      .schemaVersion,
  ).toBe(0);
});

it("makes the replacement usable before its old owner loses delivery authority", async () => {
  await resetRegistrationObjects();
  const c = new RegistrationCoordinator(env);
  await c.register("account-a", deviceInput("phone-a"), "original", now);
  const before = milestone();
  const allow = milestone();
  const after = milestone();
  const finish = milestone();
  let paused = false;
  const replacement = new RegistrationCoordinator({
    ...env,
    PUSH_TOKENS: {
      getByName(name: string) {
        const stub = env.PUSH_TOKENS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "transfer")
              return async (request: Parameters<typeof stub.transfer>[0]) => {
                if (request.reference.kind !== "push" || paused) return stub.transfer(request);
                paused = true;
                before.resolve();
                await allow.promise;
                const result = await stub.transfer(request);
                after.resolve();
                await finish.promise;
                return result;
              };
            return Reflect.get(target, method, target);
          },
        });
      },
    },
  });
  const pending = replacement.register("account-b", deviceInput("phone-b"), "replacement", now);
  try {
    await before.promise;
    expect((await c.views("account-a", now))[0]!.candidate.device!.push?.token).toBe("shared-push");
    expect((await c.views("account-b", now))[0]!.candidate.device!.push).toBeNull();
    allow.resolve();
    await after.promise;
    expect((await c.views("account-a", now))[0]!.candidate.device!.push).toBeNull();
    expect((await c.views("account-b", now))[0]!.candidate.device!.push?.token).toBe("shared-push");
  } finally {
    allow.resolve();
    finish.resolve();
    await pending;
  }
});

it("keeps the working token's routing while a different replacement is stalled", async () => {
  await resetRegistrationObjects();
  const c = new RegistrationCoordinator(env);
  await c.register("account-a", deviceInput("phone-a"), "original-routing", now);
  const entered = milestone();
  const release = milestone();
  let pause = true;
  const delayed = new RegistrationCoordinator({
    ...env,
    PUSH_TOKENS: {
      getByName(name: string) {
        const stub = env.PUSH_TOKENS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "transfer")
              return async (request: Parameters<typeof stub.transfer>[0]) => {
                if (pause) {
                  pause = false;
                  entered.resolve();
                  await release.promise;
                }
                return stub.transfer(request);
              };
            return Reflect.get(target, method, target);
          },
        });
      },
    },
  });
  const pending = delayed.register(
    "account-a",
    {
      kind: "device",
      registration: {
        ...registration("phone-a", "replacement-push"),
        pushToStartToken: "replacement-start",
        bundleId: "test.example.replacement",
        apsEnvironment: "production",
      },
    },
    "replacement-routing",
    now,
  );
  try {
    await entered.promise;
    const working = (await c.views("account-a", now))[0]!.candidate.device!;
    expect(working.push?.token).toBe("shared-push");
    expect(working.registration).toMatchObject({
      bundleId: "test.example.phone",
      apsEnvironment: "sandbox",
    });
  } finally {
    release.resolve();
    await pending;
  }
});

it("settles a multi-token registration when a competing transfer wins one domain", async () => {
  await resetRegistrationObjects();
  const c = new RegistrationCoordinator(env);
  await c.register(
    "account-a",
    {
      kind: "device",
      registration: { ...registration("phone-a"), pushToStartToken: "shared-start" },
    },
    "first-owner",
    now,
  );
  await c.register("account-b", deviceInput("phone-b", "old-push-b"), "working-b", now);
  const entered = milestone();
  const release = milestone();
  let pause = true;
  const competing = new RegistrationCoordinator({
    ...env,
    PUSH_TOKENS: {
      getByName(name: string) {
        const stub = env.PUSH_TOKENS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "transfer")
              return async (request: Parameters<typeof stub.transfer>[0]) => {
                if (pause && request.reference.kind === "push") {
                  pause = false;
                  entered.resolve();
                  await release.promise;
                }
                return stub.transfer(request);
              };
            return Reflect.get(target, method, target);
          },
        });
      },
    },
  });
  const pending = competing.register(
    "account-b",
    {
      kind: "device",
      registration: { ...registration("phone-b"), pushToStartToken: "shared-start" },
    },
    "competing-b",
    now,
  );
  try {
    await entered.promise;
    await c.register("account-c", deviceInput("phone-c"), "later-c", now);
  } finally {
    release.resolve();
    await pending;
  }
  await abortAllDurableObjects();
  const b = (await c.views("account-b", now))[0]!.candidate.device!;
  expect(b.push).toBeNull();
  expect(b.start?.token).toBe("shared-start");
  expect((await c.views("account-c", now))[0]!.candidate.device!.push?.token).toBe("shared-push");
  const rejected = (await c.snapshot("account-b", now)).records[0]!.active.device!.push!;
  expect(
    await env.PUSH_TOKENS.getByName(pushTokenName("push", "shared-push")).transfer({
      version,
      reference: rejected,
      expected: rejected.generation - 1,
      now,
    }),
  ).toEqual({ applied: false });
  expect((await c.snapshot("account-b", now)).records[0]!.pending).toBeNull();
});

it("orders a direct revocation after the currently running registration callback", async () => {
  await resetRegistrationObjects();
  const owner = await sessionOwner();
  const entered = milestone();
  const release = milestone();
  let pause = true;
  const c = new RegistrationCoordinator({
    ...env,
    PUSH_TOKENS: {
      getByName(name: string) {
        const stub = env.PUSH_TOKENS.getByName(name);
        return new Proxy(stub, {
          get(target, method) {
            if (method === "transfer")
              return async (request: Parameters<typeof stub.transfer>[0]) => {
                if (pause) {
                  pause = false;
                  entered.resolve();
                  await release.promise;
                }
                return stub.transfer(request);
              };
            return Reflect.get(target, method, target);
          },
        });
      },
    },
  });
  const pending = c.register(
    owner.userId,
    { ...deviceInput("phone-a"), sessionId: owner.sessionId },
    "in-flight",
    now,
  );
  await entered.promise;
  const account = env.ACCOUNTS.getByName(accountName(owner.userId));
  const revoke = Promise.resolve(
    account.identity({
      version,
      userId: owner.userId,
      command: { kind: "revoke-session", sessionId: owner.sessionId },
    }),
  );
  try {
    expect(
      await account.registrations({
        version,
        userId: owner.userId,
        command: { kind: "read", now },
      }),
    ).toMatchObject({ records: [{ pending: { id: "in-flight" } }] });
  } finally {
    release.resolve();
    await pending;
  }
  expect(await revoke).toMatchObject({ revoked: true });
  expect((await c.snapshot(owner.userId, now)).records).toEqual([]);
});

it("does not require an old account or inventory on a known-token replacement", async () => {
  await resetRegistrationObjects();
  const c = new RegistrationCoordinator(env);
  await c.register("account-a", deviceInput("phone-a"), "original", now);
  await c.register("account-b", deviceInput("phone-b", "other-push"), "other", now);
  const isolated = new RegistrationCoordinator({
    ...env,
    INVENTORY: namespaceWith(env.INVENTORY, () => {
      throw new Error("Synthetic inventory outage");
    }),
    ACCOUNTS: namespaceWith(env.ACCOUNTS, (name: string) => {
      if (name === accountName("account-a")) throw new Error("Synthetic old account outage");
      return env.ACCOUNTS.getByName(name);
    }),
  });
  await isolated.register("account-b", deviceInput("phone-b"), "replacement", now);
  expect((await isolated.views("account-b", now))[0]!.candidate.device!.push?.token).toBe(
    "shared-push",
  );
});

it("skips an unreachable token without denying another valid device", async () => {
  await resetRegistrationObjects();
  const c = new RegistrationCoordinator(env);
  await c.register("account-a", deviceInput("phone-a", "push-a"), "first", now);
  await c.register("account-a", deviceInput("phone-b", "push-b"), "second", now);
  const unavailable = new RegistrationCoordinator({
    ...env,
    PUSH_TOKENS: {
      getByName(name: string) {
        if (name === pushTokenName("push", "push-a")) throw new Error("Synthetic token outage");
        return env.PUSH_TOKENS.getByName(name);
      },
    },
  });
  const views = await unavailable.views("account-a", now);
  expect(views.find((row) => row.deviceId === "phone-a")!.candidate.device!.push).toBeNull();
  expect(views.find((row) => row.deviceId === "phone-b")!.candidate.device!.push?.token).toBe(
    "push-b",
  );
  expect((await c.views("account-a", now))[0]!.candidate.device!.push?.token).toBe("push-a");
});

it("upgrades account version 4 with all existing rows preserved", async () => {
  await resetRegistrationObjects();
  const userId = "account-upgrade";
  const account = () => env.ACCOUNTS.getByName(accountName(userId));
  const before = await runInDurableObject(account(), async (_instance, ctx) => {
    await ctx.storage.deleteAll();
    migrate(ctx.storage, accountMigrations.slice(0, 4));
    identity(ctx.storage, {
      version,
      command: {
        kind: "create",
        state: {
          userId,
          email: "upgrade@example.test",
          epoch: 1,
          mapping: null,
          pending: null,
          createdAt: now,
          updatedAt: now,
          lastSignInAt: now,
        },
      },
    });
    ctx.storage.sql.exec(
      "INSERT INTO tunnel_operations VALUES ('environment-a', 'operation-a', ?, 'endpoint.example.test', 'tunnel-a', '{}', 'complete', '{}', ?)",
      userId,
      now,
    );
    const tables = ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'relay_object_schema' ORDER BY name",
      )
      .toArray();
    return Object.fromEntries(
      tables.map(({ name }) => [name, ctx.storage.sql.exec(`SELECT * FROM ${name}`).toArray()]),
    );
  });
  await abortAllDurableObjects();
  expect((await account().inventory({ version })).schemaVersion).toBe(5);
  const after = await runInDurableObject(account(), (_instance, ctx) =>
    Object.fromEntries(
      Object.keys(before).map((name) => [
        name,
        ctx.storage.sql.exec(`SELECT * FROM ${name}`).toArray(),
      ]),
    ),
  );
  expect(after).toEqual(before);
  const c = new RegistrationCoordinator(env);
  await c.register(userId, deviceInput("phone-a"), "new-registration", now);
  expect((await c.views(userId, now))[0]!.candidate.device!.push?.token).toBe("shared-push");
  expect(
    await env.INVENTORY.getByName(
      inventoryShardName("push-token", pushTokenName("push", "shared-push")),
    ).list({ version, kind: "push-token", after: "", limit: 1000 }),
  ).toContainEqual({ name: pushTokenName("push", "shared-push") });
});

it("discovers a cold legacy orphan activity after its first delivery mark", async () => {
  await resetRegistrationObjects();
  const c = new RegistrationCoordinator(env);
  await c.mutate(
    "orphan-account",
    "orphan-phone",
    { kind: "mark", deviceId: "orphan-phone", end: false, keepToken: false, aggregate: null, now },
    now,
  );
  const name = accountName("orphan-account");
  expect(
    await env.INVENTORY.getByName(inventoryShardName("account", name)).list({
      version,
      kind: "account",
      after: "",
      limit: 1000,
    }),
  ).toContainEqual({ name });
  await abortAllDurableObjects();
  await c.register(
    "orphan-account",
    {
      kind: "activity",
      registration: { deviceId: "orphan-phone", activityPushToken: "orphan-card" },
    },
    "orphan-registration",
    now,
  );
  expect(await c.accountIds()).toContain("orphan-account");
  const orphan = (await c.views("orphan-account", now, true))[0]!;
  expect(orphan.candidate.device).toBeNull();
  expect(orphan.candidate.activity?.token?.token).toBe("orphan-card");
  expect(await c.cleanup({ kind: "account", userId: "orphan-account" }, now)).toEqual([]);
});
