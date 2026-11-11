import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { waitForHttpReady } from "./httpReadiness.ts";

it.effect(
  "waits past desktop's three minutes while copy progress is live, then becomes ready",
  () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      let ready = false;
      const client = HttpClient.make((request) =>
        Deferred.succeed(first, undefined).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  copy: {
                    phase: "copying",
                    copiedBytes: 1024,
                    totalBytes: 100000,
                    leaseMs: 60000,
                  },
                }),
                { status: ready ? 200 : 503 },
              ),
            ),
          ),
        ),
      );
      const waiter = yield* waitForHttpReady({
        baseUrl: "http://localhost",
        timeoutMs: 180000,
        intervalMs: 1000,
        makeError: () => "not ready",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* Deferred.await(first);
      yield* TestClock.adjust("4 minutes");
      assert.isUndefined(waiter.pollUnsafe());
      ready = true;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(waiter);
    }),
);

it.effect("stops waiting when a copying server no longer responds", () =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    let alive = true;
    const client = HttpClient.make((request) =>
      alive
        ? Deferred.succeed(first, undefined).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    copy: { phase: "copying", copiedBytes: 1, totalBytes: 100000, leaseMs: 60000 },
                  }),
                  { status: 503 },
                ),
              ),
            ),
          )
        : Effect.never,
    );
    const waiter = yield* waitForHttpReady({
      baseUrl: "http://localhost",
      timeoutMs: 180000,
      intervalMs: 1000,
      makeError: () => "not ready",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
    yield* Deferred.await(first);
    yield* TestClock.adjust("1 second");
    alive = false;
    yield* TestClock.adjust("64 seconds");
    const result = waiter.pollUnsafe();
    assert.isDefined(result);
    if (result !== undefined) assert.isTrue(Exit.isFailure(result));
  }),
);

it.effect("allows normal startup when a live server gives up exactly at lease expiry", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const start = Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
    const first = yield* Deferred.make<void>();
    let ready = false;
    const client = HttpClient.make((request) => {
      const leaseMs = Math.max(
        0,
        60000 - (Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n) - start),
      );
      return Deferred.succeed(first, undefined).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                copy: { phase: "copying", copiedBytes: 1, totalBytes: 100000, leaseMs },
              }),
              { status: ready ? 200 : 503 },
            ),
          ),
        ),
      );
    });
    const waiter = yield* waitForHttpReady({
      baseUrl: "http://localhost",
      timeoutMs: 180000,
      intervalMs: 1000,
      makeError: () => "not ready",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
    yield* Deferred.await(first);
    yield* TestClock.adjust("60 seconds");
    assert.isUndefined(waiter.pollUnsafe());
    ready = true;
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(waiter);
  }),
);

it.effect("allows a final probe when receiving progress consumes the remaining lease", () =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    let calls = 0;
    const client = HttpClient.make((request) =>
      Deferred.succeed(first, undefined).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            ++calls === 1
              ? new Response(
                  JSON.stringify({
                    copy: { phase: "copying", copiedBytes: 1, totalBytes: 100, leaseMs: 1 },
                  }),
                  { status: 503 },
                )
              : new Response("{}"),
          ),
        ),
      ),
    );
    const waiter = yield* waitForHttpReady({
      baseUrl: "http://localhost",
      timeoutMs: 180000,
      intervalMs: 1,
      probeTimeoutMs: 1,
      onStartupCopy: () => Effect.sleep("2 millis"),
      makeError: () => "not ready",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
    yield* Deferred.await(first);
    yield* TestClock.adjust("3 millis");
    yield* Fiber.join(waiter);
  }),
);
