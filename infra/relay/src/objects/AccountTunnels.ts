import type { ManagedEndpointAllocation } from "../environments/ManagedEndpointAllocations.ts";
import type { StoredLink } from "./AccountLinks.ts";
import { loadJournal } from "./AccountJournal.ts";
import type { JournalRow } from "./AccountJournal.ts";
import { canonicalJson, summarize } from "./storage.ts";

export type StoredAllocation = {
  -readonly [K in keyof ManagedEndpointAllocation]: ManagedEndpointAllocation[K];
} & {
  partialNameClaims?: { hostname?: number; tunnel?: number };
  nameGeneration?: number;
  nameOperationId?: string;
  nameClaims?: { hostname: number; tunnel: number };
  recoveryEnabledAt: string | null;
  recoveryEnvironmentPublicKey: string | null;
};
export type AllocationCommand =
  | { kind: "get"; environmentId: string }
  | {
      kind: "record-partial-names";
      environmentId: string;
      reservationId: string;
      partialNameClaims: { hostname?: number; tunnel?: number };
    }
  | { kind: "confirm-release"; environmentId: string; reservationId: string }
  | {
      kind: "reserve";
      environmentId: string;
      hostname: string;
      tunnelName: string;
      reservationId: string;
      reservationGeneration?: number;
    }
  | {
      kind: "confirm-names";
      environmentId: string;
      reservationId: string;
      nameClaims: { hostname: number; tunnel: number };
    }
  | { kind: "record-tunnel"; environmentId: string; tunnelId: string; generation: number }
  | {
      kind: "record-dns";
      environmentId: string;
      tunnelId: string;
      dnsRecordId: string;
      generation: number;
    }
  | {
      kind: "mark-ready";
      environmentId: string;
      tunnelId: string;
      origin: NonNullable<ManagedEndpointAllocation["origin"]>;
      generation: number;
    }
  | {
      kind: "enable-recovery";
      environmentId: string;
      tunnelId: string;
      environmentPublicKey: string;
      origin: NonNullable<ManagedEndpointAllocation["origin"]>;
    }
  | {
      kind: "claim-release";
      environmentId: string;
      tunnelId: string;
      generation: number;
      markReleased?: boolean;
    }
  | { kind: "claim-deprovision" | "remove-claimed"; environmentId: string; generation: number }
  | { kind: "claimed"; environmentId: string; tunnelId: string; generation: number };
export const tunnelMigration = `CREATE TABLE account_allocations(environment_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE account_allocation_intents(environment_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE account_allocation_releases(operation_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE account_allocation_generations(environment_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TABLE account_capacity_claims(environment_id TEXT PRIMARY KEY, token TEXT NOT NULL);
CREATE TABLE account_tunnel_limit(singleton INTEGER PRIMARY KEY CHECK(singleton=1), max_tunnels INTEGER NOT NULL);`;
export interface TunnelSnapshot {
  guardedEnvironments: string[];
  allocations: StoredAllocation[];
  links: StoredLink[];
  intents: StoredAllocation[];
  releases: StoredAllocation[];
  journal: JournalRow[];
  override: number | null;
}
export function tunnelSnapshot(storage: DurableObjectStorage): TunnelSnapshot {
  const sql = storage.sql;
  return {
    guardedEnvironments: [],
    allocations: sql
      .exec<{ value: string }>("SELECT value FROM account_allocations ORDER BY environment_id")
      .toArray()
      .map((r) => JSON.parse(r.value)),
    releases: sql
      .exec<{ value: string }>(
        "SELECT value FROM account_allocation_releases ORDER BY operation_id",
      )
      .toArray()
      .map((r) => JSON.parse(r.value)),
    intents: sql
      .exec<{ value: string }>(
        "SELECT value FROM account_allocation_intents ORDER BY environment_id",
      )
      .toArray()
      .map((r) => JSON.parse(r.value)),
    links: sql
      .exec<{ value: string }>("SELECT value FROM account_links ORDER BY environment_id")
      .toArray()
      .map((r) => JSON.parse(r.value)),
    journal: loadJournal(storage),
    override:
      sql.exec<{ max_tunnels: number }>("SELECT max_tunnels FROM account_tunnel_limit").toArray()[0]
        ?.max_tunnels ?? null,
  };
}
export function saveAllocations(
  storage: DurableObjectStorage,
  allocations: StoredAllocation[],
  releases: StoredAllocation[],
) {
  storage.sql.exec("DELETE FROM account_allocation_releases");
  for (const row of releases)
    storage.sql.exec(
      "INSERT INTO account_allocation_releases VALUES (?, ?)",
      row.nameOperationId!,
      canonicalJson(row),
    );
  storage.sql.exec("DELETE FROM account_allocations");
  for (const row of allocations)
    storage.sql.exec(
      "INSERT INTO account_allocations VALUES (?, ?)",
      row.environmentId,
      canonicalJson(row),
    );
}
export function publicAllocation(row: StoredAllocation): ManagedEndpointAllocation {
  const {
    recoveryEnabledAt: _at,
    recoveryEnvironmentPublicKey: _key,
    nameClaims: _claims,
    nameOperationId: _id,
    nameGeneration: _generation,
    partialNameClaims: _partial,
    ...allocation
  } = row;
  return allocation;
}
export function recovery(row: StoredAllocation, state: TunnelSnapshot) {
  return (
    row.recoveryEnabledAt !== null &&
    row.recoveryEnvironmentPublicKey !== null &&
    state.links.some(
      (l) =>
        l.environmentId === row.environmentId &&
        l.published &&
        !l.revoked &&
        l.environmentPublicKey === row.recoveryEnvironmentPublicKey,
    )
  );
}
export function pending(state: TunnelSnapshot, environmentId: string) {
  return state.journal.some((j) => j.environmentId === environmentId && j.phase !== "complete");
}
export function counted(state: TunnelSnapshot, row: StoredAllocation, pendingCutoff: string) {
  const withdrawn = state.links.some(
    (l) =>
      l.environmentId === row.environmentId &&
      (l.revoked || !l.managedTunnelsEnabled) &&
      l.updatedAt >= row.updatedAt,
  );
  return (
    pending(state, row.environmentId) ||
    (!withdrawn &&
      ((row.updatedAt > pendingCutoff &&
        (row.tunnelReleasedAt === null || row.updatedAt > row.tunnelReleasedAt)) ||
        (row.tunnelId !== null && row.tunnelReleasedAt === null)))
  );
}
export interface AllocationResult {
  allocation: ManagedEndpointAllocation | null;
  generation: number | null;
  applied: boolean;
}
export function allocationTransition(
  state: TunnelSnapshot,
  userId: string,
  c: AllocationCommand,
  now: string,
  operationId?: string,
): AllocationResult {
  let row = state.allocations.find((r) => r.environmentId === c.environmentId);
  if (c.kind === "get")
    return {
      allocation: row?.nameClaims ? publicAllocation(row) : null,
      generation: null,
      applied: false,
    };
  if (c.kind === "confirm-release") {
    state.releases = state.releases.filter((r) => r.nameOperationId !== c.reservationId);
    return { allocation: null, generation: null, applied: true };
  }
  if (c.kind === "record-partial-names") {
    const applied = row !== undefined && row.nameOperationId === c.reservationId;
    if (applied) row!.partialNameClaims = c.partialNameClaims;
    return { allocation: null, generation: null, applied };
  }
  if (c.kind === "confirm-names") {
    const applied = row !== undefined && row.nameOperationId === c.reservationId;
    if (applied) row!.nameClaims = c.nameClaims;
    return { allocation: null, generation: null, applied };
  }
  if (c.kind === "reserve") {
    if (row) row.updatedAt = now;
    else {
      const recorded = state.intents.find((r) => r.environmentId === c.environmentId);
      row = {
        userId,
        environmentId: c.environmentId,
        hostname: recorded?.hostname ?? c.hostname,
        tunnelName: recorded?.tunnelName ?? c.tunnelName,
        tunnelId: null,
        dnsRecordId: null,
        readyAt: null,
        origin: null,
        updatedAt: now,
        generation: 0,
        tunnelReleasedAt: null,
        recoveryEnabledAt: null,
        recoveryEnvironmentPublicKey: null,
      };
      state.allocations.push(row);
    }
    row.nameOperationId = c.reservationId;
    row.nameGeneration = c.reservationGeneration!;
    return { allocation: publicAllocation(row), generation: null, applied: true };
  }
  const blocked = { allocation: null, generation: null, applied: false };
  if (!row?.nameClaims) return blocked;
  if (c.kind === "enable-recovery") {
    if (
      row.tunnelId !== c.tunnelId ||
      canonicalJson(row.origin) !== canonicalJson(c.origin) ||
      !state.links.some(
        (l) =>
          l.environmentId === c.environmentId &&
          l.published &&
          !l.revoked &&
          l.environmentPublicKey === c.environmentPublicKey &&
          l.endpoint.providerKind === "cloudflare_tunnel",
      )
    )
      return blocked;
    row.recoveryEnabledAt = now;
    row.recoveryEnvironmentPublicKey = c.environmentPublicKey;
  } else {
    const journal = state.journal.find((j) => j.environmentId === c.environmentId);
    if (
      operationId === undefined
        ? pending(state, c.environmentId)
        : !journal || journal.operationId !== operationId || journal.phase === "complete"
    )
      return blocked;
    if (
      row.generation !== c.generation ||
      ("tunnelId" in c && c.kind !== "record-tunnel" && row.tunnelId !== c.tunnelId)
    )
      return blocked;
    if (c.kind === "claimed") return { ...blocked, applied: true };
    if (c.kind === "remove-claimed") {
      state.releases.push({ ...row });
      state.allocations = state.allocations.filter((r) => r !== row);
      return { ...blocked, applied: true };
    }
    if (c.kind === "record-tunnel") {
      if (row.tunnelId !== c.tunnelId) {
        row.readyAt = null;
        row.origin = null;
        row.recoveryEnabledAt = null;
        row.recoveryEnvironmentPublicKey = null;
      }
      row.tunnelId = c.tunnelId;
      row.tunnelReleasedAt = null;
    }
    if (c.kind === "record-dns") row.dnsRecordId = c.dnsRecordId;
    if (c.kind === "mark-ready") {
      row.readyAt = now;
      row.origin = c.origin;
    }
    if (c.kind === "claim-release" && c.markReleased) row.tunnelReleasedAt = now;
  }
  row.generation++;
  if (c.kind !== "claim-deprovision" && (c.kind !== "claim-release" || c.markReleased))
    row.updatedAt = now;
  return { allocation: null, generation: row.generation, applied: true };
}
export function tunnelInventory(storage: DurableObjectStorage) {
  return [
    summarize(
      "account_allocation_generations",
      storage.sql.exec(
        "SELECT environment_id, generation FROM account_allocation_generations ORDER BY environment_id",
      ),
    ),
    summarize(
      "account_capacity_claims",
      storage.sql.exec(
        "SELECT environment_id, token FROM account_capacity_claims ORDER BY environment_id",
      ),
    ),
    summarize(
      "relay_managed_endpoint_allocations",
      storage.sql.exec(
        "SELECT environment_id, value FROM account_allocations ORDER BY environment_id",
      ),
    ),
    summarize(
      "account_allocation_releases",
      storage.sql.exec(
        "SELECT operation_id, value FROM account_allocation_releases ORDER BY operation_id",
      ),
    ),
    summarize(
      "account_allocation_intents",
      storage.sql.exec(
        "SELECT environment_id, value FROM account_allocation_intents ORDER BY environment_id",
      ),
    ),
    summarize(
      "relay_managed_tunnel_limits",
      storage.sql.exec("SELECT max_tunnels FROM account_tunnel_limit"),
    ),
  ];
}

export function nextReservationGeneration(storage: DurableObjectStorage, environmentId: string) {
  return storage.sql
    .exec<{ generation: number }>(
      "INSERT INTO account_allocation_generations VALUES (?, 1) ON CONFLICT(environment_id) DO UPDATE SET generation = generation + 1 RETURNING generation",
      environmentId,
    )
    .one().generation;
}

export function tunnelLookup(
  storage: DurableObjectStorage,
  input: { environmentId: string; tunnelName: string; epoch: number },
) {
  const sql = storage.sql;
  const value = sql
    .exec<{ value: string }>(
      "SELECT value FROM account_allocations WHERE environment_id = ?",
      input.environmentId,
    )
    .toArray()[0];
  const row: StoredAllocation | null = value ? JSON.parse(value.value) : null;
  if (!row || row.tunnelName !== input.tunnelName || row.nameClaims?.tunnel !== input.epoch)
    return null;
  const linked = sql
    .exec<{ value: string }>(
      "SELECT value FROM account_links WHERE environment_id = ?",
      input.environmentId,
    )
    .toArray()[0];
  const link: StoredLink | null = linked ? JSON.parse(linked.value) : null;
  const journal = sql
    .exec<{ phase: string }>(
      "SELECT phase FROM tunnel_operations WHERE environment_id = ?",
      input.environmentId,
    )
    .toArray()[0];
  return {
    allocation: publicAllocation(row),
    pending: journal !== undefined && journal.phase !== "complete",
    recoveryEnabled:
      row.recoveryEnabledAt !== null &&
      row.recoveryEnvironmentPublicKey !== null &&
      link !== null &&
      link.published &&
      !link.revoked &&
      link.environmentPublicKey === row.recoveryEnvironmentPublicKey,
  };
}
