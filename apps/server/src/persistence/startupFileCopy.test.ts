import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Copy from "./startupFileCopy.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

it.effect("gives up on a pending read even when its promise never returns", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const copy = yield* Copy.withCopyBudget(1_000_000_000, () =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("60 seconds");
    const result = copy.pollUnsafe();
    assert.isTrue(result !== undefined && Exit.isFailure(result));
    if (result !== undefined && Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);
      assert.instanceOf(error, Copy.StartupCopyLimit);
      if (error instanceof Copy.StartupCopyLimit) assert.equal(error.reason, "stalled");
    }
  }),
);

it.effect.each([
  { size: 1_000_000_000, limitSeconds: 900 },
  { size: 100_000_000_000, limitSeconds: 5000 },
])("ends $size bytes at its outer deadline despite continuing progress", ({ size, limitSeconds }) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<(bytes: number) => void>();
    const copy = yield* Copy.withCopyBudget(size, (progress) =>
      Deferred.succeed(started, progress).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    const progress = yield* Deferred.await(started);
    for (let step = 1; step < limitSeconds / 50; step++) {
      yield* TestClock.adjust("50 seconds");
      assert.isUndefined(copy.pollUnsafe());
      progress(step * 1024);
    }
    yield* TestClock.adjust("50 seconds");
    const result = copy.pollUnsafe();
    assert.isTrue(result !== undefined && Exit.isFailure(result));
    if (result !== undefined && Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);
      assert.instanceOf(error, Copy.StartupCopyLimit);
      if (error instanceof Copy.StartupCopyLimit) assert.equal(error.reason, "deadline");
    }
  }),
);

it.effect("streams exact bytes across chunk boundaries before reporting completion", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "pruning-stream-",
    });
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 13 }, (_, i) => i % 251);
    yield* fs.writeFile(`${root}/source`, bytes);
    const progress: number[] = [];
    yield* Copy.streamDatabaseFile(`${root}/source`, `${root}/staging`, (n) => {
      progress.push(n);
    });
    if (HostProcess.Platform.defaultValue() !== "win32")
      assert.equal((yield* fs.stat(`${root}/staging`)).mode & 0o777, 0o600);
    assert.deepEqual(yield* fs.readFile(`${root}/staging`), bytes);
    assert.equal(progress.at(-1), bytes.length);
  }).pipe(Effect.provide(NodeServices.layer)),
);
