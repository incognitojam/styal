import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  TunnelOperationPersistence,
  type TunnelOperationIntent,
} from "../persistence/TunnelOperationPersistence.ts";

const intent: TunnelOperationIntent = {
  userId: "user-a",
  environmentId: "environment-a",
  hostname: "endpoint.example.test",
  tunnelName: "managed-a",
  desired: { kind: "provision", origin: { localHttpHost: "localhost", localHttpPort: 3000 } },
};

export function tunnelOperationContract<E>(
  name: string,
  layer: Layer.Layer<TunnelOperationPersistence, E>,
) {
  describe(name, () => {
    it.effect(
      "retains intent across restart, reserves incompatible work, and fences stale completions",
      () =>
        Effect.gen(function* () {
          const journal = yield* TunnelOperationPersistence;
          const first = yield* journal.begin(intent);
          expect(first).not.toBeNull();
          if (!first) return;
          yield* TestClock.adjust("1 day");
          const restarted = yield* journal.pending(1);
          expect(restarted[0]?.operationId).toBe(first.operationId);
          expect(restarted[0]?.hostname).toBe(intent.hostname);
          expect((yield* journal.begin(intent))?.operationId).toBe(first.operationId);
          expect(yield* journal.begin({ ...intent, desired: { kind: "release" } })).toBeNull();
          expect(
            yield* journal.advance(first.operationId, "create-tunnel:confirmed", {
              tunnelId: "tunnel-a",
            }),
          ).toBe(true);
          expect(
            yield* journal.advance(first.operationId, "create-dns:confirmed", {
              dnsRecordId: "dns-a",
            }),
          ).toBe(true);
          expect((yield* journal.pending(1))[0]?.resources).toEqual({
            tunnelId: "tunnel-a",
            dnsRecordId: "dns-a",
          });
          expect(yield* journal.complete(first.operationId, "intent")).toBe(false);
          expect(yield* journal.pending(1)).toHaveLength(1);
          yield* journal.complete(first.operationId);
          const next = yield* journal.begin({ ...intent, desired: { kind: "release" } });
          expect(next?.operationId).not.toBe(first.operationId);
          expect(yield* journal.begin(intent, first.operationId)).toBeNull();
          expect(yield* journal.advance(first.operationId, "late-result")).toBe(false);
          expect(yield* journal.complete(first.operationId)).toBe(false);
          expect((yield* journal.pending(1))[0]?.desired.kind).toBe("release");
        }).pipe(Effect.provide(layer)),
    );
  });
}
