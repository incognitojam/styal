import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  TunnelOperationPersistence,
  TunnelOperationPersistenceError,
} from "../persistence/TunnelOperationPersistence.ts";
import type { TunnelOperation } from "../persistence/TunnelOperationPersistence.ts";
import type { AccountObject } from "./AccountObject.ts";
import type { InventoryObject } from "./InventoryObject.ts";
import { accountName, inventoryShardName, inventoryShardNames } from "./names.ts";
import { checkLimit, RPC_VERSION } from "./storage.ts";

export interface ObjectBindings {
  ACCOUNTS: DurableObjectNamespace<AccountObject>;
  INVENTORY: DurableObjectNamespace<InventoryObject>;
}

export function tunnelOperationsLayer(bindings: ObjectBindings) {
  const call = <A>(body: () => Promise<A>) =>
    Effect.tryPromise({
      try: body,
      catch: (cause) => new TunnelOperationPersistenceError({ cause }),
    });
  const account = (id: string) => bindings.ACCOUNTS.getByName(accountName(id));
  const operationAccount = (operationId: string) => {
    const parsed: unknown = JSON.parse(operationId);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    )
      throw new Error("Invalid object operation ID");
    return account(parsed[0]);
  };
  const advance = Effect.fn("relay.object_tunnel_operations.advance")(
    (
      operationId: string,
      phase: string,
      resources: Readonly<Record<string, string>> = {},
      expectedPhase?: string,
    ) =>
      call(async () => {
        const [result] = await operationAccount(operationId).journal({
          version: RPC_VERSION,
          commands: [
            {
              kind: "advance",
              operationId,
              phase,
              resources,
              ...(expectedPhase === undefined ? {} : { expectedPhase }),
            },
          ],
        });
        if (result?.kind !== "advance") throw new Error("Unexpected journal RPC response");
        return result.applied;
      }),
  );
  return Layer.succeed(
    TunnelOperationPersistence,
    TunnelOperationPersistence.of({
      begin: Effect.fn("relay.object_tunnel_operations.begin")((intent, expectedOperationId) =>
        call(async () => {
          const name = accountName(intent.userId);
          await bindings.INVENTORY.getByName(inventoryShardName("account", name)).register({
            version: RPC_VERSION,
            references: [{ kind: "account", name }],
          });
          const [result] = await account(intent.userId).journal({
            version: RPC_VERSION,
            commands: [
              {
                kind: "begin",
                intent,
                ...(expectedOperationId === undefined ? {} : { expectedOperationId }),
              },
            ],
          });
          if (result?.kind !== "begin") throw new Error("Unexpected journal RPC response");
          return result.operation;
        }),
      ),
      advance,
      complete: Effect.fn("relay.object_tunnel_operations.complete")((id, expectedPhase) =>
        advance(id, "complete", {}, expectedPhase),
      ),
      pending: Effect.fn("relay.object_tunnel_operations.pending")((limit) =>
        call(async () => {
          checkLimit(limit);
          const operations: Array<TunnelOperation & { updatedAt: string }> = [];
          // Inventory is discovery only; authorization never depends on these references.
          for (const shard of inventoryShardNames) {
            let after = "";
            for (;;) {
              const refs = await bindings.INVENTORY.getByName(shard).list({
                version: RPC_VERSION,
                kind: "account",
                after,
                limit: 1000,
              });
              for (const ref of refs) {
                const [result] = await bindings.ACCOUNTS.getByName(ref.name).journal({
                  version: RPC_VERSION,
                  commands: [{ kind: "pending", limit }],
                });
                if (result?.kind !== "pending") throw new Error("Unexpected journal RPC response");
                operations.push(...result.operations);
                operations.sort((a, b) =>
                  a.updatedAt < b.updatedAt
                    ? -1
                    : a.updatedAt > b.updatedAt
                      ? 1
                      : a.operationId < b.operationId
                        ? -1
                        : a.operationId > b.operationId
                          ? 1
                          : 0,
                );
                operations.splice(limit);
              }
              if (refs.length < 1000) break;
              after = refs[refs.length - 1]!.name;
            }
          }
          return operations;
        }),
      ),
    }),
  );
}
