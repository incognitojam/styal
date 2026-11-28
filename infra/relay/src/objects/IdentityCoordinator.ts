import type { IdentityCommand, IdentityState, StoredSession } from "./AccountIdentity.ts";
import type { AccountObject } from "./AccountObject.ts";
import type { EmailObject, EmailOwner } from "./EmailObject.ts";
import type { CredentialRouteObject } from "./CredentialRouteObject.ts";
import type { InventoryObject } from "./InventoryObject.ts";
import {
  accountName,
  emailName,
  credentialRouteName,
  inventoryShardName,
  inventoryShardNames,
} from "./names.ts";
import type { ObjectKind } from "./names.ts";
import { RPC_VERSION } from "./storage.ts";

export interface IdentityBindings {
  ACCOUNTS: DurableObjectNamespace<AccountObject>;
  EMAILS: DurableObjectNamespace<EmailObject>;
  CREDENTIAL_ROUTES: DurableObjectNamespace<CredentialRouteObject>;
  INVENTORY: DurableObjectNamespace<InventoryObject>;
}
const version = RPC_VERSION;
export class IdentityCoordinator {
  readonly bindings: IdentityBindings;
  readonly emailKey: Uint8Array;
  constructor(bindings: IdentityBindings, emailKey: Uint8Array) {
    this.bindings = bindings;
    this.emailKey = emailKey;
  }
  account(userId: string) {
    return this.bindings.ACCOUNTS.getByName(accountName(userId));
  }
  email(address: string) {
    return this.bindings.EMAILS.getByName(emailName(address, this.emailKey));
  }
  route(sessionId: string) {
    return this.bindings.CREDENTIAL_ROUTES.getByName(credentialRouteName("session", sessionId));
  }
  async register(kind: ObjectKind, name: string) {
    await this.bindings.INVENTORY.getByName(inventoryShardName(kind, name)).register({
      version,
      references: [{ kind, name }],
    });
  }
  async command(userId: string, command: IdentityCommand) {
    return await this.account(userId).identity({ version, userId, command });
  }
  async read(userId: string) {
    const result = await this.command(userId, { kind: "read" });
    if (!("state" in result)) throw new Error("Unexpected account response");
    return result.state;
  }
  async mapped(address: string) {
    const owner = await this.email(address).resolve({ version });
    if (!owner) return null;
    const state = await this.read(owner.userId);
    return state && !state.pending && state.email === address && matches(state, owner)
      ? state
      : null;
  }
  async signup(
    address: string,
    userId: string,
    operationId: string,
    now: string,
    importing: boolean,
  ) {
    const existing = importing ? await this.read(userId) : null;
    if (existing && existing.mapping?.operationId !== operationId) {
      const losing = await this.email(address).resolve({ version });
      if (
        losing?.userId === userId &&
        losing.operationId === operationId &&
        !matches(existing, losing)
      ) {
        await this.email(address).release({ version, owner: losing, now });
      }
      return null;
    }
    await this.register("email", emailName(address, this.emailKey));
    const owner = await this.email(address).claim({
      version,
      userId,
      accountEpoch: 1,
      operationId,
      signup: !importing,
    });
    if (!owner) return null;
    if (importing && owner.operationId !== operationId) return null;
    await this.register("account", accountName(owner.userId));
    const mapping = { ...owner, email: address };
    const state: IdentityState = {
      userId: owner.userId,
      email: address,
      mapping,
      epoch: owner.accountEpoch,
      pending: {
        operationId: owner.operationId,
        requested: address,
        old: null,
        epoch: owner.accountEpoch,
        phase: "release",
      },
      createdAt: now,
      updatedAt: now,
      lastSignInAt: importing ? null : now,
    };
    const result = await this.command(owner.userId, { kind: "create", state });
    if (!("state" in result) || !result.state) throw new Error("Account creation failed");
    if (!matches(result.state, owner)) {
      if (owner.operationId === operationId) {
        await this.email(address).release({ version, owner, now });
        if (importing) return null;
      }
      await this.recoverEmail(owner.userId, now);
      throw new Error("Email claim no longer matches account");
    }
    await this.recoverEmail(owner.userId, now);
    const current = await this.mapped(address);
    if (!current) throw new Error("Email ownership is pending or changed");
    if (!importing)
      await this.command(current.userId, { kind: "touch", now, epoch: current.epoch });
    return current;
  }
  async beginEmail(userId: string, address: string | null, operationId: string, now: string) {
    await this.register("account", accountName(userId));
    const current = await this.read(userId);
    if (current?.pending) await this.recoverEmail(userId, now);
    const result = await this.command(userId, {
      kind: "begin-email",
      userId,
      operationId,
      email: address,
      now,
    });
    if (
      "state" in result &&
      result.state?.pending &&
      result.state.pending.operationId !== operationId
    ) {
      await this.recoverEmail(userId, now);
      const retry = await this.command(userId, {
        kind: "begin-email",
        userId,
        operationId,
        email: address,
        now,
      });
      if (
        "state" in retry &&
        retry.state?.pending?.operationId !== operationId &&
        retry.state?.pending
      )
        throw new Error("Concurrent email change");
    }
  }
  async advanceEmail(userId: string, now: string) {
    const state = await this.read(userId);
    const pending = state?.pending;
    if (!state || !pending) return false;
    if (pending.phase === "claim") {
      let mapping = null;
      if (pending.requested !== null) {
        await this.register("email", emailName(pending.requested, this.emailKey));
        const owner = await this.email(pending.requested).claim({
          version,
          userId,
          accountEpoch: pending.epoch,
          operationId: pending.operationId,
          signup: false,
        });
        if (owner) mapping = { ...owner, email: pending.requested };
      }
      await this.command(userId, {
        kind: "commit-email",
        operationId: pending.operationId,
        mapping,
        now,
      });
    } else {
      if (pending.old) {
        const { email, ...owner } = pending.old;
        await this.email(email).release({ version, owner: { userId, ...owner }, now });
      }
      await this.command(userId, { kind: "finish-email", operationId: pending.operationId });
    }
    return true;
  }
  async recoverEmail(userId: string, now: string) {
    // Each persisted operation has two forward-only phases; retries use the recorded intent.
    await this.advanceEmail(userId, now);
    await this.advanceEmail(userId, now);
    const state = await this.read(userId);
    if (state?.pending) throw new Error("Concurrent identity work remains pending");
    return state;
  }
  async syncEmail(userId: string, address: string | null, operationId: string, now: string) {
    await this.beginEmail(userId, address, operationId, now);
    const state = await this.recoverEmail(userId, now);
    if (!state) throw new Error("Account missing after email sync");
    return state;
  }
  async openSession(session: StoredSession) {
    await this.register("account", accountName(session.userId));
    await this.command(session.userId, { kind: "open-session", session });
    await this.publishSession(session.userId, session.sessionId);
  }
  async publishSession(userId: string, sessionId: string) {
    const result = await this.command(userId, { kind: "session", sessionId });
    if (!("session" in result) || !result.session || result.session.revoked)
      throw new Error("Session absent or revoked");
    await this.register("credential-route", credentialRouteName("session", sessionId));
    await this.route(sessionId).publish({ version, destination: userId });
    const published = await this.command(userId, { kind: "publish-session", sessionId });
    if (!("session" in published) || !published.session)
      throw new Error("Session revoked during publication");
  }
  async forEach(kind: "account" | "email", visit: (name: string) => Promise<void>) {
    for (const shard of inventoryShardNames) {
      let after = "";
      for (;;) {
        const refs = await this.bindings.INVENTORY.getByName(shard).list({
          version,
          kind,
          after,
          limit: 1000,
        });
        for (const ref of refs) await visit(ref.name);
        if (refs.length < 1000) break;
        after = refs[refs.length - 1]!.name;
      }
    }
  }
}
function matches(state: IdentityState, owner: EmailOwner) {
  return (
    state.userId === owner.userId &&
    state.epoch === owner.accountEpoch &&
    state.mapping?.emailEpoch === owner.emailEpoch &&
    state.mapping.operationId === owner.operationId
  );
}
