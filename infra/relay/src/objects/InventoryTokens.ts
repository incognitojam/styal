import type {
  SuccessfulTokenClaim,
  TokenInventoryCommand,
  TokenRetirement,
} from "./TokenProtocol.ts";
import { canonicalJson } from "./storage.ts";

export const tokenInventoryMigration =
  "CREATE TABLE token_lifecycles (name TEXT NOT NULL, incarnation TEXT NOT NULL, epoch INTEGER NOT NULL UNIQUE, value TEXT NOT NULL, PRIMARY KEY(name, incarnation)); CREATE TABLE token_heads (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE token_epoch_counter (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), epoch INTEGER NOT NULL, cutoff TEXT NOT NULL); INSERT INTO token_epoch_counter VALUES (1, 0, '')";
export interface TokenLifecycle {
  name: string;
  incarnation: string;
  epoch: number;
  phase: "preparing" | "active" | "retiring" | "retired" | "cancelled";
  expiresAt: string | null;
  retirement: TokenRetirement | null;
  retirementId?: string;
}
export interface TokenHead {
  epoch: number;
  lastClaim: SuccessfulTokenClaim | null;
  expiresAt: string | null;
}
const life = (storage: DurableObjectStorage, name: string, incarnation: string) => {
  const row = storage.sql
    .exec<{ value: string }>(
      "SELECT value FROM token_lifecycles WHERE name = ? AND incarnation = ?",
      name,
      incarnation,
    )
    .toArray()[0];
  return row ? (JSON.parse(row.value) as TokenLifecycle) : null;
};
const head = (storage: DurableObjectStorage, name: string) => {
  const row = storage.sql
    .exec<{ value: string }>("SELECT value FROM token_heads WHERE name = ?", name)
    .toArray()[0];
  return row ? (JSON.parse(row.value) as TokenHead) : null;
};
const save = (storage: DurableObjectStorage, value: TokenLifecycle) =>
  storage.sql.exec(
    "INSERT INTO token_lifecycles VALUES (?, ?, ?, ?) ON CONFLICT(name, incarnation) DO UPDATE SET value = excluded.value",
    value.name,
    value.incarnation,
    value.epoch,
    canonicalJson(value),
  );
const saveHead = (storage: DurableObjectStorage, name: string, value: TokenHead) =>
  storage.sql.exec(
    "INSERT INTO token_heads VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
    name,
    canonicalJson(value),
  );
const epoch = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{ epoch: number }>(
      "UPDATE token_epoch_counter SET epoch = epoch + 1 WHERE epoch < 9007199254740991 RETURNING epoch",
    )
    .one().epoch;
function unregisterIfUnused(storage: DurableObjectStorage, name: string) {
  if (
    !storage.sql
      .exec(
        "SELECT 1 FROM token_lifecycles WHERE name = ? AND json_extract(value, '$.phase') IN ('preparing', 'active', 'retiring') LIMIT 1",
        name,
      )
      .toArray().length
  )
    storage.sql.exec("DELETE FROM object_references WHERE kind = 'push-token' AND name = ?", name);
}
export function tokenInventory(storage: DurableObjectStorage, command: TokenInventoryCommand) {
  return storage.transactionSync(() => {
    if (command.kind === "prune") {
      storage.sql.exec(
        "UPDATE token_epoch_counter SET cutoff = max(cutoff, ?)",
        command.admissionBefore,
      );
      const names = storage.sql
        .exec<{ name: string }>(
          "DELETE FROM token_lifecycles WHERE json_extract(value, '$.phase') IN ('retired', 'cancelled') AND json_extract(value, '$.expiresAt') < ? RETURNING name",
          command.expiresBefore,
        )
        .toArray();
      storage.sql.exec(
        "DELETE FROM token_heads WHERE json_extract(value, '$.expiresAt') < ?",
        command.expiresBefore,
      );
      for (const row of names) unregisterIfUnused(storage, row.name);
      return { applied: true };
    }
    const current =
      command.kind === "retire"
        ? life(storage, command.name, command.retirement.incarnation)
        : "incarnation" in command && command.incarnation
          ? life(storage, command.name, command.incarnation)
          : null;
    if (command.kind === "read") return { lifecycle: current, head: head(storage, command.name) };
    if (command.kind === "ticket") {
      if (current) return { lifecycle: current };
      const cutoff = storage.sql
        .exec<{ cutoff: string }>("SELECT cutoff FROM token_epoch_counter")
        .one().cutoff;
      if (command.admittedAt <= cutoff) return { expired: true } as const;
      const created: TokenLifecycle = {
        name: command.name,
        incarnation: command.incarnation,
        epoch: epoch(storage),
        phase: "preparing",
        expiresAt: null,
        retirement: null,
      };
      save(storage, created);
      storage.sql.exec(
        "INSERT OR IGNORE INTO object_references VALUES ('push-token', ?)",
        command.name,
      );
      return { lifecycle: created };
    }
    if (command.kind === "cancel-ticket") {
      if (current?.phase === "active" || current?.phase === "retiring") return { applied: false };
      if (current?.phase === "retired") return { applied: true };
      save(storage, {
        name: command.name,
        incarnation: command.incarnation,
        epoch: current?.epoch ?? epoch(storage),
        phase: "cancelled",
        retirement: null,
        expiresAt:
          current?.expiresAt && current.expiresAt > command.expiresAt
            ? current.expiresAt
            : command.expiresAt,
      });
      unregisterIfUnused(storage, command.name);
      return { applied: true };
    }
    if (
      !current ||
      current.epoch !== (command.kind === "retire" ? command.retirement.epoch : command.epoch)
    )
      return { applied: false };
    const previous = head(storage, command.name);
    if (command.kind === "activate") {
      if (current.phase !== "preparing" && current.phase !== "active") return { applied: false };
      if (previous && previous.epoch > command.epoch) return { applied: false };
      save(storage, { ...current, phase: "active" });
      saveHead(storage, command.name, {
        epoch: command.epoch,
        lastClaim: previous?.lastClaim ?? null,
        expiresAt: null,
      });
      return { applied: true };
    }
    if (command.kind === "retire") {
      const retirement = command.retirement;
      if (current.phase === "retiring" || current.phase === "retired")
        return { applied: (current.retirement?.id ?? current.retirementId) === retirement.id };
      if (current.phase !== "active" || previous?.epoch !== retirement.epoch)
        return { applied: false };
      save(storage, {
        ...current,
        phase: "retiring",
        retirement,
        expiresAt: retirement.admissionExpiresAt,
      });
      const preparations = storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM token_lifecycles WHERE name = ? AND json_extract(value, '$.phase') = 'preparing'",
          command.name,
        )
        .toArray();
      for (const row of preparations) {
        const pending = JSON.parse(row.value) as TokenLifecycle;
        save(storage, { ...pending, phase: "cancelled", expiresAt: retirement.admissionExpiresAt });
      }
      saveHead(storage, command.name, {
        epoch: retirement.epoch,
        lastClaim: retirement.lastClaim ?? previous.lastClaim,
        expiresAt: retirement.expiresAt,
      });
      storage.sql.exec(
        "DELETE FROM object_references WHERE kind = 'push-token' AND name = ?",
        command.name,
      );
      return { applied: true };
    }
    if (
      (current.retirement?.id ?? current.retirementId) !== command.id ||
      (current.phase !== "retiring" && current.phase !== "retired")
    )
      return { applied: false };
    save(storage, { ...current, phase: "retired", retirement: null, retirementId: command.id });
    unregisterIfUnused(storage, command.name);
    return { applied: true };
  });
}
