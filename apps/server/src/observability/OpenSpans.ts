import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";

/**
 * Spans that have started and not ended yet.
 *
 * The trace file only records a span when it ends, so work that never
 * finishes leaves no record there. Shutdown reads these to name the step it
 * is waiting on.
 */
export class OpenSpans extends Context.Service<
  OpenSpans,
  {
    readonly list: Effect.Effect<ReadonlyArray<Tracer.Span>>;
  }
>()("@styal/cli/observability/OpenSpans") {}

/** Wrap a tracer so every span it creates is listed until it ends. */
export const trackOpenSpans = (tracer: Tracer.Tracer) => {
  const open = new Set<Tracer.Span>();
  const tracked = Tracer.make({
    span(options) {
      const span = tracer.span(options);
      open.add(span);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        open.delete(span);
        end(endTime, exit);
      };
      return span;
    },
    ...(tracer.context ? { context: tracer.context } : {}),
  });
  return {
    tracer: tracked,
    openSpans: OpenSpans.of({ list: Effect.sync(() => Array.from(open)) }),
  };
};

// The desktop app kills its backend two seconds after asking it to stop, and
// the service launcher after five. Reports at 1.5, 3 and 4.5 seconds land
// before each kill, and the later ones cover steps that start after the
// provider stop. Stopping a Claude session can take two seconds on its own,
// so a report is not always a fault.
const STALLED_SHUTDOWN_REPORT_INTERVAL = Duration.millis(1_500);
const STALLED_SHUTDOWN_REPORTS = 3;
const MAX_REPORTED_SPANS = 40;

const ageMs = (now: bigint, span: Tracer.Span) =>
  Number((now - span.status.startTime) / 1_000_000n);

/**
 * Log when shutdown starts, then list the open spans at each report time
 * while it is still running. Build this layer last so its finalizer runs
 * first.
 */
export const reportStalledShutdown = Layer.effectDiscard(
  Effect.gen(function* () {
    const openSpans = yield* OpenSpans;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeNanos;
        yield* Effect.logInfo("Server shutdown started");
        yield* Effect.gen(function* () {
          yield* Effect.sleep(STALLED_SHUTDOWN_REPORT_INTERVAL);
          const now = yield* Clock.currentTimeNanos;
          const spans = (yield* openSpans.list).toSorted(
            (left, right) => ageMs(now, left) - ageMs(now, right),
          );
          yield* Effect.logInfo("Server shutdown is still running", {
            elapsedMs: Number((now - startedAt) / 1_000_000n),
            openSpanCount: spans.length,
            // Newest first: the work shutdown itself started comes first.
            openSpans: spans
              .slice(0, MAX_REPORTED_SPANS)
              .map((span) => `${span.name} (${ageMs(now, span)} ms)`),
          });
        }).pipe(Effect.repeat({ times: STALLED_SHUTDOWN_REPORTS - 1 }), Effect.forkDetach);
      }),
    );
  }),
);

/**
 * Tear a layer down inside a `shutdown.<name>` span, so the stalled shutdown
 * report names a group whose finalizers are still running. Layers shared with
 * other groups stay shared; their teardown counts toward the group that
 * releases them last.
 */
export const traceShutdown =
  (name: string) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, E, R> =>
    Layer.fromBuild((memoMap, scope) =>
      Effect.gen(function* () {
        const layerScope = yield* Scope.fork(scope, "sequential");
        const context = yield* Layer.buildWithMemoMap(layer, memoMap, layerScope);
        // Effect.addFinalizer keeps the build context, so the span reaches the
        // server tracer when the root scope closes.
        yield* Effect.addFinalizer((exit) =>
          Scope.close(layerScope, exit).pipe(Effect.withSpan(`shutdown.${name}`)),
        ).pipe(Effect.provideService(Scope.Scope, scope));
        return context;
      }),
    );
