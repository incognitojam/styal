import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayConfiguration from "../Config.ts";
import { persistenceCause } from "../auth/persistenceCause.ts";
import {
  RegistrationCleanupPersistence,
  RegistrationCleanupReadError,
} from "../persistence/DeliveryTargetPersistence.ts";
import { config } from "../test/fixtures.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as LiveActivityCleanup from "./LiveActivityCleanup.ts";

function harness(
  churn: "once" | "always" | "never",
  readError?: RegistrationCleanupReadError | EffectDrizzleQueryError,
  apns = true,
  readErrorAt = 1,
) {
  let generation = 0;
  let reads = 0;
  const queued: string[] = [];
  const layer = Layer.mergeAll(
    RelayConfiguration.layer({ ...config, apns: apns ? config.apns : null }),
    Layer.succeed(RegistrationCleanupPersistence, {
      listTargets: () =>
        Effect.suspend(() => {
          reads++;
          return readError === undefined || reads !== readErrorAt
            ? Effect.succeed([
                {
                  userId: "account-a",
                  deviceId: "phone-a",
                  token: `token-${generation}`,
                  bundleId: "test.example.phone",
                  apsEnvironment: "sandbox" as const,
                },
              ])
            : Effect.fail(readError);
        }),
    }),
    Layer.mock(ApnsDeliveryQueue.ApnsDeliveryQueue, {
      enqueueLiveActivity: (input) =>
        Effect.sync(() => {
          queued.push(input.token);
          if (churn === "always" || (churn === "once" && generation === 0)) generation++;
          return {
            deviceId: input.deviceId,
            kind: input.kind,
            ok: true,
            queued: true,
            apnsStatus: null,
            apnsReason: null,
            apnsId: null,
          };
        }),
    }),
  );
  return { layer, queued, reads: () => reads };
}

describe("Live Activity cleanup handshake", () => {
  it.effect.each(["once", "always"] as const)(
    "rechecks a changed registration after enqueue (%s)",
    (churn) => {
      const h = harness(churn);
      return Effect.gen(function* () {
        const cleanup = yield* LiveActivityCleanup.make;
        let attempts = 0;
        let removed = false;
        const remove = cleanup.removeAfterEnds(
          { kind: "account", userId: "account-a" },
          (confirm) =>
            Effect.gen(function* () {
              attempts++;
              yield* confirm;
              removed = true;
            }),
        );
        if (churn === "once") {
          yield* remove;
          expect(h.queued).toEqual(["token-0", "token-1"]);
          expect(attempts).toBe(2);
          expect(removed).toBe(true);
        } else {
          expect(yield* remove.pipe(Effect.flip)).toBeInstanceOf(
            LiveActivityCleanup.LiveActivityRegistrationsChanged,
          );
          expect(h.queued).toEqual(["token-0", "token-1", "token-2"]);
          expect(attempts).toBe(3);
          expect(removed).toBe(false);
        }
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect.each([1, 2] as const)(
    "preserves the storage cause and never removes after a failed read (%s)",
    (readErrorAt) => {
      const cause = new EffectDrizzleQueryError({
        query: "synthetic query",
        params: [],
        cause: { code: "synthetic-sql-state" },
      });
      const h = harness("never", cause, true, readErrorAt);
      return Effect.gen(function* () {
        const cleanup = yield* LiveActivityCleanup.make;
        let removed = false;
        const error = yield* cleanup
          .removeAfterEnds({ kind: "account", userId: "account-a" }, (confirm) =>
            Effect.gen(function* () {
              yield* confirm;
              removed = true;
            }),
          )
          .pipe(Effect.flip);
        expect(error).toBe(cause);
        expect(persistenceCause(error)).toEqual(persistenceCause(cause));
        expect(h.queued).toEqual(readErrorAt === 1 ? [] : ["token-0"]);
        expect(h.reads()).toBe(readErrorAt);
        expect(removed).toBe(false);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("removes without reading or enqueueing when APNs is disabled", () => {
    const h = harness("never", new RegistrationCleanupReadError({ cause: "must not read" }), false);
    return Effect.gen(function* () {
      const cleanup = yield* LiveActivityCleanup.make;
      const result = yield* cleanup.removeAfterEnds(
        { kind: "account", userId: "account-a" },
        (confirm) => confirm.pipe(Effect.as("removed")),
      );
      expect(result).toBe("removed");
      expect(h.reads()).toBe(0);
      expect(h.queued).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
});
