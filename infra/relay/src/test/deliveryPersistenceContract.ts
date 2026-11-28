import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  ApiPausePersistence,
  DeliveryAttemptPersistence,
} from "../persistence/DeliveryPersistence.ts";

const claim = (sourceJobId: string) => ({
  sourceJobId,
  userId: "account-a",
  environmentId: "environment-a",
  threadId: "thread-a",
  deviceId: "phone-a",
  kind: "push_notification",
  token: "synthetic-push-token",
});

export function deliveryAttemptContract<E>(
  name: string,
  layer: Layer.Layer<DeliveryAttemptPersistence, E>,
) {
  describe(name, () => {
    it.effect(
      "claims a source job once concurrently and keeps retries in flight until the exact lease boundary",
      () =>
        Effect.gen(function* () {
          const attempts = yield* DeliveryAttemptPersistence;
          const input = claim("job-a");
          expect(
            (yield* Effect.all([attempts.claimSourceJob(input), attempts.claimSourceJob(input)], {
              concurrency: "unbounded",
            })).toSorted(),
          ).toEqual(["claimed", "in_flight"]);
          yield* TestClock.adjust("599999 millis");
          expect(yield* attempts.claimSourceJob(input)).toBe("in_flight");
          yield* TestClock.adjust("1 millis");
          expect(
            (yield* Effect.all([attempts.claimSourceJob(input), attempts.claimSourceJob(input)], {
              concurrency: "unbounded",
            })).toSorted(),
          ).toEqual(["claimed", "in_flight"]);
          expect(
            yield* attempts.claimSourceJob({ ...input, userId: "account-b", deviceId: "phone-b" }),
          ).toBe("in_flight");
          expect(yield* attempts.claimSourceJob(claim("job-b"))).toBe("claimed");
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "treats any stored outcome as completed and permits replacement or empty completion as the source does",
      () =>
        Effect.gen(function* () {
          const attempts = yield* DeliveryAttemptPersistence;
          for (const [index, outcome] of [
            { apnsStatus: 200 },
            { apnsReason: "Synthetic skip" },
            { apnsId: "synthetic-apns-id" },
            { transportError: "Synthetic transport failure" },
          ].entries()) {
            const input = claim(`job-${index}`);
            expect(yield* attempts.claimSourceJob(input)).toBe("claimed");
            yield* attempts.completeSourceJob({ sourceJobId: input.sourceJobId, ...outcome });
            yield* TestClock.adjust("10 minutes");
            expect(yield* attempts.claimSourceJob(input)).toBe("completed");
            yield* attempts.completeSourceJob({ sourceJobId: input.sourceJobId });
            expect(yield* attempts.claimSourceJob(input)).toBe("in_flight");
            yield* TestClock.adjust("10 minutes");
            expect(yield* attempts.claimSourceJob(input)).toBe("claimed");
          }
          yield* attempts.completeSourceJob({ sourceJobId: "missing", apnsStatus: 200 });
          expect(yield* attempts.claimSourceJob(claim("missing"))).toBe("claimed");
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "retains attempts at the exact cutoff and resets retention when a job completes",
      () =>
        Effect.gen(function* () {
          const attempts = yield* DeliveryAttemptPersistence;
          const old = claim("old");
          const completed = claim("completed");
          const accountless = {
            ...claim("accountless"),
            userId: null,
            environmentId: null,
            threadId: null,
            deviceId: null,
            token: null,
          };
          yield* attempts.claimSourceJob(old);
          yield* attempts.claimSourceJob(completed);
          yield* attempts.claimSourceJob(accountless);
          yield* TestClock.adjust("1 day");
          yield* attempts.completeSourceJob({
            sourceJobId: completed.sourceJobId,
            apnsStatus: 200,
          });
          yield* TestClock.adjust("6 days");
          expect(yield* attempts.pruneExpired).toBe(0);
          yield* TestClock.adjust("1 millis");
          expect(yield* attempts.pruneExpired).toBe(2);
          expect(yield* attempts.claimSourceJob(completed)).toBe("completed");
          expect(yield* attempts.claimSourceJob(old)).toBe("claimed");
          expect(yield* attempts.claimSourceJob(accountless)).toBe("claimed");
          expect(yield* attempts.pruneExpired).toBe(0);
        }).pipe(Effect.provide(layer)),
    );
  });
}

export function apiPauseContract<E>(name: string, layer: Layer.Layer<ApiPausePersistence, E>) {
  describe(name, () => {
    it.effect(
      "shares the maximum recorded deadline and returns it even after the deadline passes",
      () =>
        Effect.gen(function* () {
          const first = yield* ApiPausePersistence;
          expect(yield* first.pausedUntilMillis).toBe(0);
          yield* first.pauseUntil(-1);
          expect(yield* first.pausedUntilMillis).toBe(-1);
          yield* Effect.all(
            [first.pauseUntil(1000), first.pauseUntil(3000), first.pauseUntil(2000)],
            { concurrency: "unbounded" },
          );
          const second = yield* ApiPausePersistence;
          expect(yield* second.pausedUntilMillis).toBe(3000);
          yield* TestClock.adjust("4 seconds");
          expect(yield* second.pausedUntilMillis).toBe(3000);
          yield* second.pauseUntil(1000);
          expect(yield* first.pausedUntilMillis).toBe(3000);
          yield* second.pauseUntil(5000);
          expect(yield* first.pausedUntilMillis).toBe(5000);
          yield* second.pauseUntil(1e100);
          expect(yield* first.pausedUntilMillis).toBe(5000);
        }).pipe(Effect.provide(layer)),
    );
  });
}
