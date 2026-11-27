// @effect-diagnostics globalDate:off cryptoRandomUUID:off - Synchronous workerd transitions cannot yield to Effect services.
import { DurableObject } from "cloudflare:workers";
import type {
  TunnelOperation,
  TunnelOperationIntent,
} from "../persistence/TunnelOperationPersistence.ts";
import { identity, identityMigration, identityInventory } from "./AccountIdentity.ts";
import type { IdentityCommand } from "./AccountIdentity.ts";
import { accountName } from "./names.ts";
import { canonicalJson, checkLimit, checkRpc, migrate, summarize } from "./storage.ts";

export const accountMigrations = [
  `CREATE TABLE tunnel_operations (
    environment_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL, hostname TEXT NOT NULL, tunnel_name TEXT NOT NULL,
    desired TEXT NOT NULL, phase TEXT NOT NULL, resources TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX tunnel_operations_pending ON tunnel_operations(phase, updated_at, operation_id);`,
  identityMigration,
];

type Command =
  | { kind: "begin"; intent: TunnelOperationIntent; expectedOperationId?: string }
  | {
      kind: "advance";
      operationId: string;
      phase: string;
      resources: Readonly<Record<string, string>>;
      expectedPhase?: string;
    }
  | { kind: "pending"; limit: number };
export type JournalResult =
  | { kind: "begin"; operation: TunnelOperation | null }
  | { kind: "advance"; applied: boolean }
  | { kind: "pending"; operations: Array<TunnelOperation & { updatedAt: string }> };

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
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, accountMigrations);
    });
  }

  async identity(request: { version: number; userId: string; command: IdentityCommand }) {
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
    const result = identity(this.ctx.storage, request);
    return result;
  }

  async identityOwner(request: { version: number }) {
    const result = identity(this.ctx.storage, {
      version: request.version,
      command: { kind: "read" },
    });
    return "state" in result ? (result.state?.userId ?? null) : null;
  }

  async journal(request: {
    version: number;
    commands: readonly Command[];
  }): Promise<JournalResult[]> {
    checkRpc(request.version);
    checkLimit(request.commands.length);
    return this.ctx.storage.transactionSync(() =>
      request.commands.map((command): JournalResult => {
        const sql = this.ctx.storage.sql;
        switch (command.kind) {
          case "begin": {
            const { intent, expectedOperationId } = command;
            // Named stubs pass ctx.id.name through: https://developers.cloudflare.com/durable-objects/api/id/#name
            if (this.ctx.id.name !== accountName(intent.userId))
              throw new Error("Journal account mismatch");
            const existing = sql
              .exec<Row>(
                "SELECT * FROM tunnel_operations WHERE environment_id = ?",
                intent.environmentId,
              )
              .toArray()[0];
            const old = existing ? decode(existing) : null;
            const pending = old !== null && old.phase !== "complete";
            const sameNames =
              old?.hostname === intent.hostname && old.tunnelName === intent.tunnelName;
            const sameDesired =
              old !== null && canonicalJson(old.desired) === canonicalJson(intent.desired);
            if (expectedOperationId !== undefined) {
              if (
                !pending ||
                old.operationId !== expectedOperationId ||
                !sameNames ||
                !(intent.desired.kind === "deprovision"
                  ? old.desired.kind === "deprovision"
                  : sameDesired)
              ) {
                return { kind: "begin", operation: null };
              }
              sql.exec(
                "UPDATE tunnel_operations SET updated_at = ? WHERE operation_id = ?",
                new Date().toISOString(),
                old.operationId,
              );
              return { kind: "begin", operation: { ...old, resumed: true } };
            }
            const reuse = pending && sameDesired && intent.desired.kind !== "deprovision";
            const supersede =
              intent.desired.kind === "deprovision" ||
              (intent.desired.kind === "provision" && old?.desired.kind === "provision");
            if (pending && (!sameNames || (!reuse && !supersede)))
              return { kind: "begin", operation: null };
            const operation: TunnelOperation = reuse
              ? { ...old, resumed: true }
              : {
                  ...intent,
                  operationId: JSON.stringify([intent.userId, crypto.randomUUID()]),
                  phase: "intent",
                  resources: pending
                    ? { ...old.resources, supersededOperationId: old.operationId }
                    : {},
                  resumed: false,
                };
            sql.exec(
              `INSERT INTO tunnel_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(environment_id) DO UPDATE SET operation_id = excluded.operation_id,
            hostname = excluded.hostname, tunnel_name = excluded.tunnel_name, desired = excluded.desired,
            phase = excluded.phase, resources = excluded.resources, updated_at = excluded.updated_at`,
              operation.environmentId,
              operation.operationId,
              operation.userId,
              operation.hostname,
              operation.tunnelName,
              canonicalJson(operation.desired),
              operation.phase,
              canonicalJson(operation.resources),
              new Date().toISOString(),
            );
            return { kind: "begin", operation };
          }
          case "advance": {
            const row = sql
              .exec<Row>(
                "SELECT * FROM tunnel_operations WHERE operation_id = ? AND phase != 'complete'",
                command.operationId,
              )
              .toArray()[0];
            if (
              !row ||
              (command.expectedPhase !== undefined && row.phase !== command.expectedPhase)
            )
              return { kind: "advance", applied: false };
            sql.exec(
              "UPDATE tunnel_operations SET phase = ?, resources = ?, updated_at = ? WHERE operation_id = ?",
              command.phase,
              canonicalJson({ ...JSON.parse(row.resources), ...command.resources }),
              new Date().toISOString(),
              command.operationId,
            );
            return { kind: "advance", applied: true };
          }
          case "pending": {
            checkLimit(command.limit);
            return {
              kind: "pending",
              operations: sql
                .exec<Row>(
                  "SELECT * FROM tunnel_operations WHERE phase != 'complete' ORDER BY updated_at, operation_id LIMIT ?",
                  command.limit,
                )
                .toArray()
                .map((row) => ({ ...decode(row), updatedAt: row.updated_at })),
            };
          }
        }
      }),
    );
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
      ],
    };
  }
}
