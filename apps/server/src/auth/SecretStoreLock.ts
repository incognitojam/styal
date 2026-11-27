// @effect-diagnostics nodeBuiltinImport:off - Credential leases coordinate Node server processes.
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export class SecretStoreLockError extends Schema.TaggedError<SecretStoreLockError>()(
  "SecretStoreLockError",
  { resource: Schema.String, reason: Schema.Literals(["busy", "unavailable"]) },
) {
  override get message(): string {
    return `Could not lock ${this.resource} for an update. Try again.`;
  }
}

/** Serialize a credential transition across processes sharing a file-backed store. */
export const withSecretStoreLock = <A, E, R>(
  directory: string | undefined,
  key: string,
  task: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SecretStoreLockError, R> => {
  // In-memory test stores have no filesystem shared with other processes.
  if (!directory) return task;
  const failure = (cause?: unknown) =>
    new SecretStoreLockError({
      resource: key,
      reason:
        Predicate.hasProperty(cause, "code") && cause.code === "ELOCKED" ? "busy" : "unavailable",
    });
  return Effect.scoped(
    Effect.gen(function* () {
      const compromised = yield* Deferred.make<never, SecretStoreLockError>();
      const services = yield* Effect.context<never>();
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            lock(NodePath.join(directory, `${key}.bin`), {
              realpath: false,
              stale: 120_000,
              update: 10_000,
              retries: { retries: 80, factor: 1, minTimeout: 500, maxTimeout: 500 },
              onCompromised: () =>
                Effect.runSyncWith(services)(Deferred.fail(compromised, failure())),
            }),
          catch: failure,
        }),
        (release) => Effect.promise(() => release()).pipe(Effect.ignore),
      );
      return yield* Effect.raceFirst(task, Deferred.await(compromised));
    }),
  );
};
