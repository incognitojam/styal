import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  TunnelOperationPersistence,
  type TunnelOperation,
} from "../persistence/TunnelOperationPersistence.ts";

export const layerMemoryTunnelOperations = Layer.sync(TunnelOperationPersistence, () => {
  const operations = new Map<string, TunnelOperation>();
  let sequence = 0;
  const advance = (
    id: string,
    phase: string,
    resources: Readonly<Record<string, string>> = {},
    expectedPhase?: string,
  ) =>
    Effect.sync(() => {
      const entry = [...operations.entries()].find(
        ([, op]) => op.operationId === id && op.phase !== "complete",
      );
      if (!entry || (expectedPhase !== undefined && entry[1].phase !== expectedPhase)) return false;
      operations.set(entry[0], {
        ...entry[1],
        phase,
        resources: { ...entry[1].resources, ...resources },
      });
      return true;
    });
  return TunnelOperationPersistence.of({
    begin: (intent, expectedOperationId) =>
      Effect.sync(() => {
        const key = `${intent.userId}:${intent.environmentId}`;
        const current = operations.get(key);
        if (
          expectedOperationId !== undefined &&
          (current?.operationId !== expectedOperationId || current.phase === "complete")
        )
          return null;
        let resources: Readonly<Record<string, string>> = {};
        if (current && current.phase !== "complete") {
          if (current.hostname !== intent.hostname || current.tunnelName !== intent.tunnelName)
            return null;
          const same = NodeUtil.isDeepStrictEqual(current.desired, intent.desired);
          if (expectedOperationId !== undefined)
            return same ||
              (intent.desired.kind === "deprovision" && current.desired.kind === "deprovision")
              ? { ...current, resumed: true }
              : null;
          if (same && intent.desired.kind !== "deprovision") return { ...current, resumed: true };
          if (
            intent.desired.kind !== "deprovision" &&
            !(intent.desired.kind === "provision" && current.desired.kind === "provision")
          )
            return null;
          resources = {
            ...current.resources,
            supersededOperationId: current.operationId,
          };
        }
        const operation = {
          ...intent,
          operationId: `operation-${++sequence}`,
          phase: "intent",
          resources,
        };
        operations.set(key, operation);
        return operation;
      }),
    advance,
    complete: (id, expectedPhase) => advance(id, "complete", {}, expectedPhase),
    pending: (limit) =>
      Effect.sync(() =>
        [...operations.values()].filter((op) => op.phase !== "complete").slice(0, limit),
      ),
  });
});
