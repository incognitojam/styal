import type {
  TunnelOperation,
  TunnelOperationIntent,
} from "../persistence/TunnelOperationPersistence.ts";
import { canonicalJson, checkLimit } from "./storage.ts";
export type JournalCommand =
  | { kind: "begin"; intent: TunnelOperationIntent; expectedOperationId?: string }
  | {
      kind: "advance";
      operationId: string;
      phase: string;
      resources: Readonly<Record<string, string>>;
      expectedPhase?: string;
    }
  | { kind: "pending"; limit: number };
export type JournalRow = { -readonly [K in keyof TunnelOperation]: TunnelOperation[K] } & {
  updatedAt: string;
};
export type JournalResult =
  | { kind: "begin"; operation: TunnelOperation | null }
  | { kind: "advance"; applied: boolean }
  | { kind: "pending"; operations: JournalRow[] };
export function journalTransition(
  rows: JournalRow[],
  userId: string,
  command: JournalCommand,
  now: string,
  newId: string,
): JournalResult {
  if (command.kind === "pending") {
    checkLimit(command.limit);
    return {
      kind: "pending",
      operations: rows
        .filter((r) => r.phase !== "complete")
        .toSorted((a, b) =>
          a.updatedAt < b.updatedAt
            ? -1
            : a.updatedAt > b.updatedAt
              ? 1
              : a.operationId < b.operationId
                ? -1
                : a.operationId > b.operationId
                  ? 1
                  : 0,
        )
        .slice(0, command.limit),
    };
  }
  if (command.kind === "advance") {
    const row = rows.find((r) => r.operationId === command.operationId && r.phase !== "complete");
    if (!row || (command.expectedPhase !== undefined && row.phase !== command.expectedPhase))
      return { kind: "advance", applied: false };
    row.phase = command.phase;
    row.resources = { ...row.resources, ...command.resources };
    row.updatedAt = now;
    return { kind: "advance", applied: true };
  }
  const { intent, expectedOperationId } = command;
  if (intent.userId !== userId) throw new Error("Journal account mismatch");
  const index = rows.findIndex((r) => r.environmentId === intent.environmentId);
  const old = rows[index];
  const pending = old !== undefined && old.phase !== "complete";
  const sameNames = old?.hostname === intent.hostname && old.tunnelName === intent.tunnelName;
  const sameDesired =
    old !== undefined && canonicalJson(old.desired) === canonicalJson(intent.desired);
  if (expectedOperationId !== undefined) {
    if (
      !pending ||
      old.operationId !== expectedOperationId ||
      !sameNames ||
      !(intent.desired.kind === "deprovision" ? old.desired.kind === "deprovision" : sameDesired)
    )
      return { kind: "begin", operation: null };
    old.updatedAt = now;
    const { updatedAt: _at, ...operation } = old;
    return { kind: "begin", operation: { ...operation, resumed: true } };
  }
  const reuse = pending && sameDesired && intent.desired.kind !== "deprovision";
  const supersede =
    intent.desired.kind === "deprovision" ||
    (intent.desired.kind === "provision" && old?.desired.kind === "provision");
  if (pending && (!sameNames || (!reuse && !supersede))) return { kind: "begin", operation: null };
  const operation: TunnelOperation = reuse
    ? { ...old, resumed: true }
    : {
        ...intent,
        operationId: JSON.stringify([userId, newId]),
        phase: "intent",
        resources: pending ? { ...old.resources, supersededOperationId: old.operationId } : {},
        resumed: false,
      };
  const stored = { ...operation, updatedAt: now };
  if (index === -1) rows.push(stored);
  else rows[index] = stored;
  const { updatedAt: _at, ...result } = stored;
  return { kind: "begin", operation: result };
}
export function loadJournal(storage: DurableObjectStorage): JournalRow[] {
  return storage.sql
    .exec<{
      environment_id: string;
      operation_id: string;
      user_id: string;
      hostname: string;
      tunnel_name: string;
      desired: string;
      phase: string;
      resources: string;
      updated_at: string;
    }>("SELECT * FROM tunnel_operations ORDER BY environment_id")
    .toArray()
    .map((r) => ({
      environmentId: r.environment_id,
      operationId: r.operation_id,
      userId: r.user_id,
      hostname: r.hostname,
      tunnelName: r.tunnel_name,
      desired: JSON.parse(r.desired),
      phase: r.phase,
      resources: JSON.parse(r.resources),
      updatedAt: r.updated_at,
    }));
}
export function saveJournal(storage: DurableObjectStorage, rows: JournalRow[]) {
  storage.sql.exec("DELETE FROM tunnel_operations");
  for (const r of rows)
    storage.sql.exec(
      "INSERT INTO tunnel_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.environmentId,
      r.operationId,
      r.userId,
      r.hostname,
      r.tunnelName,
      canonicalJson(r.desired),
      r.phase,
      canonicalJson(r.resources),
      r.updatedAt,
    );
}
