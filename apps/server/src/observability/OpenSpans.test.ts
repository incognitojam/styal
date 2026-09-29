import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import { OpenSpans, reportStalledShutdown, trackOpenSpans } from "./OpenSpans.ts";

const makeTracked = () =>
  trackOpenSpans(Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }));

it.effect("lists a span while it runs and drops it when it ends", () =>
  Effect.gen(function* () {
    const { tracer, openSpans } = makeTracked();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.withSpan("held"),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    assert.deepStrictEqual(
      (yield* openSpans.list).map((span) => span.name),
      ["held"],
    );

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(yield* openSpans.list, []);
  }),
);

it.effect("names the open work when shutdown is still running", () =>
  Effect.gen(function* () {
    const { tracer, openSpans } = makeTracked();
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const finalizerStarted = yield* Deferred.make<void>();
    const releaseFinalizer = yield* Deferred.make<void>();
    // A later shutdown step that does not finish.
    const stalledStep = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Deferred.succeed(finalizerStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFinalizer)),
          Effect.withSpan("stalled.step"),
          Effect.provideService(Tracer.Tracer, tracer),
        ),
      ),
    );
    const scope = yield* Scope.make();
    yield* Layer.build(
      reportStalledShutdown.pipe(
        Layer.provideMerge(stalledStep),
        Layer.provide(Layer.succeed(OpenSpans, openSpans)),
        Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    ).pipe(Scope.provide(scope));

    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Deferred.await(finalizerStarted);
    assert.deepStrictEqual(messages, [["Server shutdown started"]]);

    yield* TestClock.adjust("1500 millis");
    yield* Effect.yieldNow;
    const reportedSpans = () =>
      messages.flatMap((message) =>
        Array.isArray(message) && message[0] === "Server shutdown is still running"
          ? [(message[1] as { readonly openSpans: ReadonlyArray<string> }).openSpans]
          : [],
      );
    assert.deepStrictEqual(reportedSpans(), [["stalled.step (1500 ms)"]]);

    // Reports repeat, so a step that starts after the first report still shows.
    yield* TestClock.adjust("1500 millis");
    yield* Effect.yieldNow;
    assert.deepStrictEqual(reportedSpans(), [
      ["stalled.step (1500 ms)"],
      ["stalled.step (3000 ms)"],
    ]);

    // The third report is the last, before the launcher's five-second kill.
    yield* TestClock.adjust("3000 millis");
    yield* Effect.yieldNow;
    assert.equal(reportedSpans().length, 3);

    yield* Deferred.succeed(releaseFinalizer, undefined);
    yield* Fiber.join(closing);
  }),
);
