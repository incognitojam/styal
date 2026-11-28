// @effect-diagnostics globalDate:off cryptoRandomUUID:off - Synchronous workerd transitions cannot yield to Effect services.
import { DEFAULT_MANAGED_TUNNEL_LIMIT } from "@t3tools/contracts/relay";
import { DurableObject } from "cloudflare:workers";
import type { TunnelOperation } from "../persistence/TunnelOperationPersistence.ts";
import { identity, identityMigration, identityInventory } from "./AccountIdentity.ts";
import type { IdentityCommand } from "./AccountIdentity.ts";
import { links, linkMigration, linkInventory } from "./AccountLinks.ts";
import type { LinkCommand } from "./AccountLinks.ts";
import { accountName } from "./names.ts";
import { canonicalJson, checkLimit, checkRpc, migrate, summarize } from "./storage.ts";
import {
  registrationMigration,
  registrationOutcomeMigration,
  registrations,
  registrationRemoval,
  removalRecords,
  endSessionRegistrations,
  registrationInventory,
} from "./AccountRegistrations.ts";
import type { RegistrationCommand } from "./AccountRegistrations.ts";

export const accountMigrations = [
  `CREATE TABLE tunnel_operations (
    environment_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL, hostname TEXT NOT NULL, tunnel_name TEXT NOT NULL,
    desired TEXT NOT NULL, phase TEXT NOT NULL, resources TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX tunnel_operations_pending ON tunnel_operations(phase, updated_at, operation_id);`,
  identityMigration,
  linkMigration,
  tunnelMigration,
  registrationMigration,
  registrationOutcomeMigration,
];

export type { JournalResult } from "./AccountJournal.ts";
import { journalTransition, loadJournal, saveJournal } from "./AccountJournal.ts";
import type { JournalCommand, JournalResult } from "./AccountJournal.ts";
import {
  tunnelMigration,
  tunnelSnapshot,
  saveAllocations,
  allocationTransition,
  tunnelInventory,
  counted,
  nextReservationGeneration,
  tunnelLookup,
} from "./AccountTunnels.ts";
import type { AllocationCommand, TunnelSnapshot } from "./AccountTunnels.ts";

type Row = {
  environment_id: string;
  operation_id: string;
  user_id: string;
  hostname: string;
  tunnel_name: string;
  desired: string;
  phase: string;
  resources: string;
  updated_at: string;
};
function decode(row: Row): TunnelOperation {
  return {
    environmentId: row.environment_id,
    operationId: row.operation_id,
    userId: row.user_id,
    hostname: row.hostname,
    tunnelName: row.tunnel_name,
    desired: JSON.parse(row.desired),
    phase: row.phase,
    resources: JSON.parse(row.resources),
  };
}

export class AccountObject extends DurableObject<unknown> {
  private reservations = new Map<string, Promise<void>>();
  private registrationTails = new Map<string, Promise<void>>();
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, accountMigrations);
      ctx.storage.sql.exec("DELETE FROM account_capacity_claims");
    });
  }

  async links(request: { version: number; userId: string; command: LinkCommand }) {
    if (this.ctx.id.name !== accountName(request.userId)) throw new Error("Link account mismatch");
    if (request.command.kind === "begin" && request.command.intent.userId !== request.userId)
      throw new Error("Link owner mismatch");
    return links(this.ctx.storage, request);
  }

  async identity(request: {
    version: number;
    userId: string;
    command: IdentityCommand;
    registrationGuard?: { sessionIds: string[]; stamp: string };
  }) {
    checkRpc(request.version);
    if (this.ctx.id.name !== accountName(request.userId))
      throw new Error("Identity account mismatch");
    if (request.command.kind === "create" && request.command.state.userId !== request.userId)
      throw new Error("Identity owner mismatch");
    if (
      request.command.kind === "open-session" &&
      request.command.session.userId !== request.userId
    )
      throw new Error("Session owner mismatch");
    if (request.command.kind === "begin-email" && request.command.userId !== request.userId)
      throw new Error("Email owner mismatch");
    const command = request.command;
    if (
      command.kind !== "revoke-session" &&
      command.kind !== "prune-sessions" &&
      command.kind !== "publish-session" &&
      !(command.kind === "use-session" && command.revoke)
    )
      return identity(this.ctx.storage, request);
    const initial = registrationRemoval(this.ctx.storage, request.command);
    await Promise.all(
      initial.records.flatMap((record) => this.registrationTails.get(record.deviceId) ?? []),
    );
    return this.ctx.storage.transactionSync(() => {
      const guard = request.registrationGuard;
      if (
        guard &&
        canonicalJson(removalRecords(this.ctx.storage, guard.sessionIds)) !== guard.stamp
      )
        return { registrationsChanged: true };
      const removal = registrationRemoval(this.ctx.storage, request.command);
      if (removal.records.some((record) => record.pending)) return { registrationPending: true };
      const result = identity(this.ctx.storage, request);
      if (command.kind !== "publish-session" || ("session" in result && result.session?.revoked))
        endSessionRegistrations(this.ctx.storage, removal.sessionIds);
      return result;
    });
  }

  async registrations(request: { version: number; userId: string; command: RegistrationCommand }) {
    checkRpc(request.version);
    if (this.ctx.id.name !== accountName(request.userId))
      throw new Error("Registration account mismatch");
    return registrations(this.ctx.storage, request.userId, request.command);
  }

  async registrationRemoval(request: {
    version: number;
    userId: string;
    command: IdentityCommand;
  }) {
    checkRpc(request.version);
    if (this.ctx.id.name !== accountName(request.userId))
      throw new Error("Registration account mismatch");
    return registrationRemoval(this.ctx.storage, request.command);
  }

  async registrationGate(
    request: { version: number; userId: string; deviceId: string },
    callback: () => Promise<void>,
  ) {
    checkRpc(request.version);
    if (this.ctx.id.name !== accountName(request.userId))
      throw new Error("Registration account mismatch");
    const previous = this.registrationTails.get(request.deviceId);
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.registrationTails.set(request.deviceId, completion);
    try {
      if (previous) await previous;
      await callback();
    } finally {
      finish();
      if (this.registrationTails.get(request.deviceId) === completion)
        this.registrationTails.delete(request.deviceId);
    }
  }

  async identityOwner(request: { version: number }) {
    const result = identity(this.ctx.storage, {
      version: request.version,
      command: { kind: "read" },
    });
    return "state" in result
      ? (result.state?.userId ??
          this.ctx.storage.sql
            .exec<{ user_id: string }>("SELECT user_id FROM account_registration_owner")
            .toArray()[0]?.user_id ??
          null)
      : null;
  }

  async allocation(request: {
    version: number;
    userId: string;
    command: AllocationCommand;
    now: string;
    operationId?: string;
  }) {
    checkRpc(request.version);
    if (this.ctx.id.name !== accountName(request.userId))
      throw new Error("Allocation account mismatch");
    return this.ctx.storage.transactionSync(() => {
      const state = tunnelSnapshot(this.ctx.storage);
      const result = allocationTransition(
        state,
        request.userId,
        request.command.kind === "reserve"
          ? {
              ...request.command,
              reservationGeneration: nextReservationGeneration(
                this.ctx.storage,
                request.command.environmentId,
              ),
            }
          : request.command,
        request.now,
        request.operationId,
      );
      if (result.applied && request.command.kind !== "claimed")
        saveAllocations(this.ctx.storage, state.allocations, state.releases);
      return result;
    });
  }
  async tunnels(request: { version: number; userId: string }) {
    checkRpc(request.version);
    if (this.ctx.id.name !== accountName(request.userId))
      throw new Error("Tunnel account mismatch");
    return tunnelSnapshot(this.ctx.storage);
  }
  async tunnelLookup(request: {
    version: number;
    userId: string;
    environmentId: string;
    tunnelName: string;
    epoch: number;
  }) {
    checkRpc(request.version);
    if (this.ctx.id.name !== accountName(request.userId))
      throw new Error("Tunnel account mismatch");
    return tunnelLookup(this.ctx.storage, request);
  }
  async capacity(
    request: {
      version: number;
      userId: string;
      environmentId: string;
      token: string;
      pendingCutoff: string;
      raisedLimit?: number;
    },
    callback: (
      state: TunnelSnapshot,
      record: (allocations: TunnelSnapshot["allocations"]) => Promise<void>,
      reservationGeneration: number,
    ) => Promise<TunnelSnapshot | null>,
  ) {
    checkRpc(request.version);
    if (this.ctx.id.name !== accountName(request.userId))
      throw new Error("Capacity account mismatch");
    const previous = this.reservations.get(request.environmentId);
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.reservations.set(request.environmentId, completion);
    // This orders live callbacks; SQLite claims and generations remain authoritative across restart.
    try {
      if (previous) await previous;
      const admitted = this.ctx.storage.transactionSync(() => {
        const state = tunnelSnapshot(this.ctx.storage);
        const claims = this.ctx.storage.sql
          .exec<{ environment_id: string }>("SELECT environment_id FROM account_capacity_claims")
          .toArray();
        const combined = [
          ...state.allocations,
          ...state.intents.filter(
            (r) => !state.allocations.some((a) => a.environmentId === r.environmentId),
          ),
        ];
        const slots = new Set(
          combined
            .filter((r) => counted(state, r, request.pendingCutoff))
            .map((r) => r.environmentId),
        );
        for (const claim of claims) slots.add(claim.environment_id);
        const activeTunnels = [...slots].filter((id) => id !== request.environmentId).length;
        const maxTunnels =
          state.override ?? Math.max(DEFAULT_MANAGED_TUNNEL_LIMIT, request.raisedLimit ?? 0);
        if (activeTunnels >= maxTunnels && !slots.has(request.environmentId))
          return { state: null, activeTunnels, maxTunnels, override: state.override };
        this.ctx.storage.sql.exec(
          "INSERT INTO account_capacity_claims VALUES (?, ?) ON CONFLICT(environment_id) DO UPDATE SET token = excluded.token",
          request.environmentId,
          request.token,
        );
        return {
          state,
          activeTunnels,
          maxTunnels,
          override: state.override,
          reservationGeneration: nextReservationGeneration(this.ctx.storage, request.environmentId),
        };
      });
      if (!admitted.state)
        return {
          allowed: false,
          activeTunnels: admitted.activeTunnels,
          maxTunnels: admitted.maxTunnels,
          override: admitted.override,
        };
      const original = structuredClone(admitted.state);
      const recorded = new Map<string, string>();
      const current = () =>
        this.ctx.storage.sql
          .exec<{ token: string }>(
            "SELECT token FROM account_capacity_claims WHERE environment_id = ?",
            request.environmentId,
          )
          .toArray()[0]?.token === request.token;
      const discardRecorded = () => {
        for (const [environmentId, reservationId] of recorded)
          this.ctx.storage.sql.exec(
            "DELETE FROM account_allocation_intents WHERE environment_id = ? AND json_extract(value, '$.nameOperationId') = ?",
            environmentId,
            reservationId,
          );
      };
      let callbackReturned = false;
      try {
        const state = await callback(
          admitted.state,
          async (allocations) => {
            this.ctx.storage.transactionSync(() => {
              if (!current()) throw new Error("Reservation superseded");
              for (const row of allocations) {
                if (row.environmentId !== request.environmentId)
                  throw new Error("Reservation environment mismatch");
                this.ctx.storage.sql.exec(
                  "INSERT INTO account_allocation_intents VALUES (?, ?) ON CONFLICT(environment_id) DO UPDATE SET value = excluded.value",
                  row.environmentId,
                  canonicalJson(row),
                );
                recorded.set(row.environmentId, row.nameOperationId!);
              }
            });
          },
          admitted.reservationGeneration!,
        );
        callbackReturned = true;
        this.ctx.storage.transactionSync(() => {
          if (!current()) throw new Error("Reservation superseded");
          if (state) {
            const live = tunnelSnapshot(this.ctx.storage);
            for (const environmentId of state.guardedEnvironments)
              if (
                canonicalJson(
                  live.journal.find((j) => j.environmentId === environmentId) ?? null,
                ) !==
                canonicalJson(
                  original.journal.find((j) => j.environmentId === environmentId) ?? null,
                )
              )
                throw new Error("Reservation journal changed");
            const merge = <T>(before: T[], after: T[], present: T[], key: (v: T) => string) => {
              const ids = new Set([...before, ...after].map(key));
              for (const id of ids) {
                const was = before.find((v) => key(v) === id);
                const next = after.find((v) => key(v) === id);
                if (canonicalJson(was ?? null) === canonicalJson(next ?? null)) continue;
                if (
                  canonicalJson(present.find((v) => key(v) === id) ?? null) !==
                  canonicalJson(was ?? null)
                )
                  throw new Error("Reservation state changed");
                const index = present.findIndex((v) => key(v) === id);
                if (index !== -1) present.splice(index, 1);
                if (next) present.push(next);
              }
              return present;
            };
            const related = new Set([
              request.environmentId,
              ...state.guardedEnvironments,
              ...state.allocations
                .filter(
                  (row) =>
                    canonicalJson(row) !==
                    canonicalJson(
                      original.allocations.find((old) => old.environmentId === row.environmentId) ??
                        null,
                    ),
                )
                .map((row) => row.environmentId),
            ]);
            if (
              canonicalJson(live.links.filter((link) => related.has(link.environmentId))) !==
              canonicalJson(original.links.filter((link) => related.has(link.environmentId)))
            )
              throw new Error("Reservation link changed");
            saveAllocations(
              this.ctx.storage,
              merge(
                original.allocations,
                state.allocations,
                live.allocations,
                (r) => r.environmentId,
              ),
              merge(original.releases, state.releases, live.releases, (r) => r.nameOperationId!),
            );
            saveJournal(
              this.ctx.storage,
              merge(original.journal, state.journal, live.journal, (r) => r.environmentId),
            );
          }
          discardRecorded();
        });
        return {
          allowed: true,
          activeTunnels: admitted.activeTunnels,
          maxTunnels: admitted.maxTunnels,
          override: admitted.override,
        };
      } catch (error) {
        if (callbackReturned) this.ctx.storage.transactionSync(discardRecorded);
        throw error;
      } finally {
        this.ctx.storage.sql.exec(
          "DELETE FROM account_capacity_claims WHERE environment_id = ? AND token = ?",
          request.environmentId,
          request.token,
        );
      }
    } finally {
      finish();
      if (this.reservations.get(request.environmentId) === completion)
        this.reservations.delete(request.environmentId);
    }
  }

  async journal(request: {
    version: number;
    commands: readonly JournalCommand[];
  }): Promise<JournalResult[]> {
    checkRpc(request.version);
    checkLimit(request.commands.length);
    return this.ctx.storage.transactionSync(() => {
      const rows = loadJournal(this.ctx.storage);
      const userId =
        request.commands.find((c) => c.kind === "begin")?.intent.userId ?? rows[0]?.userId ?? "";
      if (userId && this.ctx.id.name !== accountName(userId))
        throw new Error("Journal account mismatch");
      const results = request.commands.map((c) =>
        journalTransition(rows, userId, c, new Date().toISOString(), crypto.randomUUID()),
      );
      if (request.commands.some((c) => c.kind !== "pending")) saveJournal(this.ctx.storage, rows);
      return results;
    });
  }

  async inventory(request: { version: number }) {
    checkRpc(request.version);
    const rows = this.ctx.storage.sql.exec<Row>(
      "SELECT * FROM tunnel_operations ORDER BY environment_id",
    );
    function* contents() {
      for (const row of rows) yield { ...decode(row), updatedAt: row.updated_at };
    }
    return {
      version: request.version,
      schemaVersion: accountMigrations.length,
      tables: [
        summarize("relay_tunnel_operations", contents()),
        ...identityInventory(this.ctx.storage),
        ...linkInventory(this.ctx.storage),
        ...tunnelInventory(this.ctx.storage),
        ...registrationInventory(this.ctx.storage),
      ],
    };
  }
}
