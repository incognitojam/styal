import * as DateTime from "effect/DateTime";
import type { PushTokenObject } from "./PushTokenObject.ts";
import type { InventoryObject } from "./InventoryObject.ts";
import type { AccountObject } from "./AccountObject.ts";
import type {
  TokenPreparation,
  TokenReference,
  TokenRetirement,
  TokenLoss,
} from "./TokenProtocol.ts";
import { RegistrationRecoveryRequired } from "./TokenProtocol.ts";
import { tokenClaimDigest } from "./TokenProtocol.ts";
import { accountName, inventoryShardName, inventoryShardNames, pushTokenName } from "./names.ts";
import { RPC_VERSION as version } from "./storage.ts";

export interface TokenBindings {
  PUSH_TOKENS: Pick<DurableObjectNamespace<PushTokenObject>, "getByName">;
  INVENTORY: Pick<DurableObjectNamespace<InventoryObject>, "getByName">;
  ACCOUNTS: Pick<DurableObjectNamespace<AccountObject>, "getByName">;
}
export class TokenCoordinator {
  readonly bindings: TokenBindings;
  constructor(bindings: TokenBindings) {
    this.bindings = bindings;
  }
  name(reference: Pick<TokenReference, "kind" | "token">) {
    return pushTokenName(reference.kind, reference.token);
  }
  token(reference: Pick<TokenReference, "kind" | "token">) {
    return this.bindings.PUSH_TOKENS.getByName(this.name(reference));
  }
  inventory(reference: Pick<TokenReference, "kind" | "token">) {
    return this.bindings.INVENTORY.getByName(
      inventoryShardName("push-token", this.name(reference)),
    );
  }
  async settleLoss(loss: TokenLoss) {
    try {
      await this.bindings.ACCOUNTS.getByName(accountName(loss.reference.userId)).registrations({
        version,
        userId: loss.reference.userId,
        command: {
          kind: "lose-token",
          deviceId: loss.reference.deviceId,
          reference: loss.reference,
          at: loss.at,
        },
      });
      await this.token(loss.reference).acknowledgeLoss({
        version,
        incarnation: loss.reference.incarnation ?? "legacy",
        id: loss.id,
      });
    } catch (cause) {
      throw new RegistrationRecoveryRequired({ cause });
    }
  }
  async canEnd(reference: TokenReference, now: string) {
    const state = await this.token(reference).read({ version });
    const digest = tokenClaimDigest(reference);
    if (state.initialized && state.lastClaim)
      return (
        state.lastClaim.digest === digest &&
        (state.owner
          ? tokenClaimDigest(state.owner) === digest
          : state.generation === reference.generation + 1)
      );
    const result = await this.inventory(reference).tokens({
      version,
      command: { kind: "read", name: this.name(reference) },
    });
    return !!(
      "head" in result &&
      result.head?.lastClaim?.digest === digest &&
      result.head.lastClaimExpiresAt !== null &&
      result.head.lastClaimExpiresAt > now
    );
  }
  async pruneHistory(now: string) {
    const admissionBefore = DateTime.formatIso(
      DateTime.subtract(DateTime.makeUnsafe(now), { days: 7 }),
    );
    // Existing maintenance only; registration and delivery never enumerate token objects.
    for (const shard of inventoryShardNames)
      await this.bindings.INVENTORY.getByName(shard).tokens({
        version,
        command: { kind: "prune", expiresBefore: now, admissionBefore },
      });
  }
  async ticket(preparation: TokenPreparation) {
    const result = await this.inventory(preparation.reference).tokens({
      version,
      command: {
        kind: "ticket",
        name: this.name(preparation.reference),
        incarnation: preparation.reference.incarnation ?? "legacy",
        admittedAt: preparation.admittedAt,
      },
    });
    if (
      !("lifecycle" in result) ||
      !result.lifecycle ||
      (result.lifecycle.phase !== "preparing" && result.lifecycle.phase !== "active")
    )
      return null;
    return { ...preparation, epoch: result.lifecycle.epoch };
  }
  async publish(reference: TokenReference, epoch: number) {
    const result = await this.inventory(reference).tokens({
      version,
      command: {
        kind: "activate",
        name: this.name(reference),
        incarnation: reference.incarnation ?? "legacy",
        epoch,
      },
    });
    return (
      "applied" in result &&
      result.applied === true &&
      (await this.token(reference).publish({
        version,
        incarnation: reference.incarnation ?? "legacy",
        epoch,
      }))
    );
  }
  async finishRetirement(reference: TokenReference, retirement: TokenRetirement) {
    const inventory = () => this.inventory(reference);
    const stage = await inventory().tokens({
      version,
      command: { kind: "retire", name: this.name(reference), retirement },
    });
    if (!("applied" in stage) || !stage.applied) {
      const state = await this.token(reference).read({ version });
      const recorded = await inventory().tokens({
        version,
        command: { kind: "read", name: this.name(reference), incarnation: retirement.incarnation },
      });
      if (
        (!state.initialized || state.incarnation !== retirement.incarnation) &&
        "lifecycle" in recorded &&
        !recorded.lifecycle
      )
        return;
      throw new Error("Token retirement publication changed");
    }
    const deleted = await this.token(reference).retire({ version, retirement });
    if (!deleted) {
      const state = await this.token(reference).read({ version });
      if (state.initialized && state.incarnation === retirement.incarnation)
        throw new Error("Token retirement changed");
    }
    const completed = await inventory().tokens({
      version,
      command: {
        kind: "complete",
        name: this.name(reference),
        incarnation: retirement.incarnation,
        epoch: retirement.epoch,
        id: retirement.id,
      },
    });
    if (!("applied" in completed) || !completed.applied)
      throw new Error("Token retirement completion changed");
  }
  async release(reference: TokenReference, now: string, initialization?: string | null) {
    for (let help = 0; help < 3; help++) {
      const result = await this.token(reference).cancel({
        version,
        reference,
        expected: reference.generation - 1,
        now,
        initialization: initialization ?? null,
      });
      if ("unsupportedHistory" in result)
        throw new RegistrationRecoveryRequired({
          cause: "Unsupported experimental token history: previous-owner destinations were erased",
        });
      if ("pendingLoss" in result) {
        await this.settleLoss(result.pendingLoss);
        continue;
      }
      if ("retiring" in result) {
        await this.finishRetirement(reference, result.retiring);
        return;
      }
      const instant = DateTime.makeUnsafe(now);
      const expiresAt = DateTime.formatIso(DateTime.add(instant, { minutes: 10 }));
      const admissionExpiresAt = DateTime.formatIso(DateTime.add(instant, { days: 7 }));
      if ("absent" in result || "stale" in result) {
        const previous = await this.inventory(reference).tokens({
          version,
          command: {
            kind: "read",
            name: this.name(reference),
            incarnation: reference.incarnation ?? "legacy",
          },
        });
        if (
          "lifecycle" in previous &&
          previous.lifecycle?.phase === "retiring" &&
          previous.lifecycle.retirement
        ) {
          await this.finishRetirement(reference, previous.lifecycle.retirement);
          return;
        }
        const cancelled = await this.inventory(reference).tokens({
          version,
          command: {
            kind: "cancel-ticket",
            name: this.name(reference),
            incarnation: reference.incarnation ?? "legacy",
            expiresAt: admissionExpiresAt,
          },
        });
        if (!("applied" in cancelled) || !cancelled.applied)
          throw new Error("Token initialization cancellation changed");
        return;
      }
      let state = await this.token(reference).read({ version });
      if (state.owner) return;
      if (state.pendingLoss) {
        await this.settleLoss(state.pendingLoss);
        continue;
      }
      if (!state.published) {
        const ticket = await this.ticket({
          reference: { ...reference, incarnation: state.incarnation },
          expected: reference.generation - 1,
          initialization: null,
          epoch: state.epoch,
          admittedAt: now,
        });
        if (!ticket?.epoch || !(await this.publish(ticket.reference, ticket.epoch)))
          throw new Error("Token initialization publication changed");
        state = await this.token(reference).read({ version });
      }
      if (state.incarnation !== (reference.incarnation ?? "legacy")) return;
      const frozen = await this.token(reference).freeze({
        version,
        incarnation: state.incarnation,
        expiresAt,
        admissionExpiresAt,
      });
      if ("unsupportedHistory" in frozen)
        throw new RegistrationRecoveryRequired({
          cause: "Unsupported experimental token history: previous-owner destinations were erased",
        });
      if ("retirement" in frozen) await this.finishRetirement(reference, frozen.retirement);
      else if ("pendingLoss" in frozen) {
        await this.settleLoss(frozen.pendingLoss);
        continue;
      } else if (!("busy" in frozen) && !("stale" in frozen))
        throw new Error("Token retirement is not ready");
      return;
    }
    throw new RegistrationRecoveryRequired({ cause: "Token cleanup repeatedly changed" });
  }
}
