// Streaming speech-to-text engine backed by the t3-dictation sidecar
// (native/dictation): Parakeet TDT 0.6B GGUF via transcribe-cpp.
//
// One sidecar process handles one utterance. Model load is ~0.5-0.7s warm from
// page cache but ~10s on first cold read, so the engine keeps one pre-spawned
// process ready and replaces it after each utterance; an idle timeout reclaims
// the warm process (and its model memory) when dictation goes unused.
//
// Design and measurements: .plans/dictation.md, native/dictation-spike/README.md.

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { ServerConfig } from "../config.ts";

// --- events ------------------------------------------------------------------

export const DictationReadyEvent = Schema.Struct({
  type: Schema.Literal("ready"),
  backend: Schema.String,
  loadMs: Schema.Number,
  supportsStreaming: Schema.NullishOr(Schema.Boolean),
});

export const DictationUpdateEvent = Schema.Struct({
  type: Schema.Literal("update"),
  committed: Schema.String,
  tentative: Schema.String,
  audioMs: Schema.Number,
  /** Compute-seconds per audio-second; approaching 1.0 means falling behind. */
  rtf: Schema.Number,
});

export const DictationFinalEvent = Schema.Struct({
  type: Schema.Literal("final"),
  text: Schema.String,
  audioMs: Schema.Number,
  rtf: Schema.Number,
  finalizeMs: Schema.Number,
});

export const DictationFatalEvent = Schema.Struct({
  type: Schema.Literal("fatal"),
  message: Schema.String,
});

export const DictationSidecarEvent = Schema.Union([
  DictationReadyEvent,
  DictationUpdateEvent,
  DictationFinalEvent,
  DictationFatalEvent,
]);
export type DictationSidecarEvent = typeof DictationSidecarEvent.Type;

const decodeSidecarEvent = Schema.decodeUnknownEffect(DictationSidecarEvent);

// --- errors ------------------------------------------------------------------

export class DictationUnavailable extends Data.TaggedError("DictationUnavailable")<{
  readonly reason: "sidecar-missing" | "model-missing";
  readonly detail: string;
}> {}

export class DictationSidecarFailed extends Data.TaggedError("DictationSidecarFailed")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export type DictationError = DictationUnavailable | DictationSidecarFailed;

// --- service -----------------------------------------------------------------

export interface DictationStatus {
  readonly available: boolean;
  readonly reason: string | undefined;
  readonly warm: boolean;
}

export class DictationEngine extends Context.Service<
  DictationEngine,
  {
    /**
     * Transcribes one utterance. `pcm` is raw 16 kHz mono f32 little-endian
     * audio; the stream ending marks the end of speech and triggers finalize.
     * The sidecar's lifetime is tied to the returned stream — interrupting it
     * (a client disconnect) kills the process.
     */
    readonly stream: <E>(
      pcm: Stream.Stream<Uint8Array, E>,
    ) => Stream.Stream<DictationSidecarEvent, DictationError>;
    readonly status: Effect.Effect<DictationStatus>;
  }
>()("t3/dictation/DictationEngine") {}

/** Reclaim the warm sidecar (and its ~600MB of model memory) after disuse. */
const IDLE_UNLOAD_AFTER = Duration.minutes(5);

const sidecarBinaryName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "t3-dictation.exe" : "t3-dictation";

interface WarmSidecar {
  readonly scope: Scope.Closeable;
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
}

export const make = Effect.fn("dictation.engine.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig;
  const platform = yield* HostProcessPlatform;

  const warm = yield* Ref.make(Option.none<WarmSidecar>());
  const lastUsedAt = yield* Ref.make(0);
  // One utterance at a time: each sidecar owns a resident model, and
  // concurrent utterances would need concurrent models (~600MB each).
  const utteranceMutex = yield* Semaphore.make(1);

  const touch = Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(lastUsedAt, now));

  /**
   * An explicitly configured path is authoritative: if it is wrong, say so
   * rather than silently running a different binary found on disk. Otherwise
   * search packaged resources, then in-repo dev builds.
   */
  const configuredSidecarPath = (): string | undefined => {
    const configured = process.env["T3CODE_DICTATION_SIDECAR_PATH"] ?? config.dictationSidecarPath;
    return configured === undefined || configured === "" ? undefined : configured;
  };

  const sidecarCandidates = () => {
    const executable = sidecarBinaryName(platform);
    const configured = configuredSidecarPath();
    if (configured !== undefined) {
      return [configured];
    }
    return [
      path.resolve(import.meta.dirname, "dictation", executable),
      path.resolve(import.meta.dirname, "../dictation", executable),
      path.resolve(import.meta.dirname, "../../../../native/dictation/target/release", executable),
      path.resolve(import.meta.dirname, "../../../../native/dictation/target/debug", executable),
      path.resolve(import.meta.dirname, "../../../native/dictation/target/release", executable),
      path.resolve(import.meta.dirname, "../../../native/dictation/target/debug", executable),
    ];
  };

  const resolveSidecar: Effect.Effect<string, DictationUnavailable> = Effect.gen(function* () {
    for (const candidate of sidecarCandidates()) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    const configured = configuredSidecarPath();
    return yield* new DictationUnavailable({
      reason: "sidecar-missing",
      detail:
        configured === undefined
          ? "t3-dictation sidecar not found; build native/dictation or set T3CODE_DICTATION_SIDECAR_PATH"
          : `t3-dictation sidecar not found at ${configured}`,
    });
  });

  const resolveModel: Effect.Effect<string, DictationUnavailable> = Effect.gen(function* () {
    const configured = process.env["T3CODE_DICTATION_MODEL_PATH"] ?? config.dictationModelPath;
    if (configured === undefined || configured === "") {
      return yield* new DictationUnavailable({
        reason: "model-missing",
        detail: "no dictation model configured; set T3CODE_DICTATION_MODEL_PATH to a Parakeet GGUF",
      });
    }
    if (!(yield* fileSystem.exists(configured).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new DictationUnavailable({
        reason: "model-missing",
        detail: `dictation model not found at ${configured}`,
      });
    }
    return configured;
  });

  const spawnSidecar: Effect.Effect<WarmSidecar, DictationError> = Effect.gen(function* () {
    const sidecarPath = yield* resolveSidecar;
    const modelPath = yield* resolveModel;
    const scope = yield* Scope.make();
    const handle = yield* ChildProcess.make(sidecarPath, [modelPath], {
      stdin: { stream: "pipe", endOnDone: true },
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGKILL",
    }).pipe(
      Effect.mapError(
        (cause) => new DictationSidecarFailed({ detail: `failed to spawn ${sidecarPath}`, cause }),
      ),
      Scope.provide(scope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return { scope, handle };
  });

  const closeSidecar = (sidecar: WarmSidecar) =>
    Scope.close(sidecar.scope, Exit.void).pipe(Effect.ignore);

  const takeOrSpawn: Effect.Effect<WarmSidecar, DictationError> = utteranceMutex.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.getAndSet(warm, Option.none());
      if (Option.isSome(current)) {
        return current.value;
      }
      return yield* spawnSidecar;
    }),
  );

  const replaceWarm: Effect.Effect<void> = Effect.gen(function* () {
    const replacement = yield* spawnSidecar.pipe(Effect.option);
    const previous = yield* Ref.getAndSet(warm, replacement);
    if (Option.isSome(previous)) {
      yield* closeSidecar(previous.value);
    }
  });

  // Idle reclaim: a warm sidecar holds the model resident; drop it when
  // dictation has gone unused for a while. The next utterance eats the load
  // cost (small while the model file is still in page cache).
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.minutes(1));
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(lastUsedAt);
      if (last === 0 || now - last < Duration.toMillis(IDLE_UNLOAD_AFTER)) {
        continue;
      }
      const current = yield* Ref.getAndSet(warm, Option.none());
      if (Option.isSome(current)) {
        yield* closeSidecar(current.value);
        yield* Effect.logInfo("dictation: unloaded idle sidecar");
      }
    }
  }).pipe(Effect.interruptible, Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const current = yield* Ref.getAndSet(warm, Option.none());
      if (Option.isSome(current)) {
        yield* closeSidecar(current.value);
      }
    }),
  );

  const stream: DictationEngine["Service"]["stream"] = <E>(pcm: Stream.Stream<Uint8Array, E>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* touch;
        const sidecar = yield* takeOrSpawn;
        // The utterance owns this process: whatever happens, it dies with the
        // request scope (a client disconnect must not leave orphans), and a
        // replacement starts warming for the next utterance.
        yield* Effect.addFinalizer(() =>
          closeSidecar(sidecar).pipe(
            Effect.andThen(touch),
            Effect.andThen(Effect.forkDetach(replaceWarm)),
            Effect.asVoid,
          ),
        );

        yield* Stream.run(pcm, sidecar.handle.stdin).pipe(Effect.ignore, Effect.forkScoped);
        yield* sidecar.handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

        return sidecar.handle.stdout.pipe(
          Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
          Stream.mapEffect(
            (value): Effect.Effect<DictationSidecarEvent, DictationSidecarFailed> =>
              decodeSidecarEvent(value).pipe(
                Effect.mapError(
                  (cause) =>
                    new DictationSidecarFailed({ detail: "undecodable sidecar event", cause }),
                ),
                Effect.flatMap((event) =>
                  event.type === "fatal"
                    ? Effect.fail(new DictationSidecarFailed({ detail: event.message }))
                    : Effect.succeed(event),
                ),
              ),
          ),
          Stream.mapError((cause) =>
            cause instanceof DictationSidecarFailed
              ? cause
              : new DictationSidecarFailed({ detail: "sidecar stream failed", cause }),
          ),
          // The sidecar emits "final" and exits; end the stream there rather
          // than surfacing the process EOF as an error.
          Stream.takeUntil((event) => event.type === "final"),
        );
      }),
    );

  const status: Effect.Effect<DictationStatus> = Effect.gen(function* () {
    const failure = yield* resolveSidecar.pipe(
      Effect.andThen(resolveModel),
      Effect.as(undefined),
      Effect.catchTag("DictationUnavailable", (error) => Effect.succeed(error.detail)),
    );
    return {
      available: failure === undefined,
      reason: failure,
      warm: Option.isSome(yield* Ref.get(warm)),
    };
  });

  return DictationEngine.of({ stream, status });
});

export const layer = Layer.effect(DictationEngine, make());
