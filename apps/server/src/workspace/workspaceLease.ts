import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

export const makeWorkspaceLease = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn("workspace.withWorkspaceLease")(function* <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    const resolved = path.resolve(cwd);
    const key = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
    const lease = leases.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(key, lease);
    lease.users++;
    return yield* lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(key);
        }),
      ),
    );
  });
});
