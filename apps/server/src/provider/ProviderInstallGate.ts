/**
 * Turn starts wait for an install of their CLI so it is never replaced while launching. Another
 * server's install is seen only through its lock, which names the installer but not the package,
 * so those waits cover every CLI that installer owns.
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProviderInstallLock from "./ProviderInstallLock.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

const REMOTE_INSTALL_POLL_INTERVAL = Duration.seconds(1);

/** One installed CLI: the installer that owns it and the package it installs. */
export interface ProviderInstallTarget {
  /** The installer's lock key, such as one npm prefix or Homebrew. */
  readonly lockKey: string;
  readonly packageName: string | null;
}

const sameTarget = (a: ProviderInstallTarget, b: ProviderInstallTarget) =>
  a.lockKey === b.lockKey && a.packageName === b.packageName;

interface LocalInstall {
  readonly target: ProviderInstallTarget;
  readonly done: Deferred.Deferred<void>;
}

export class ProviderInstallGate extends Context.Service<
  ProviderInstallGate,
  {
    /**
     * Runs `install` under the machine-wide lock for `target.lockKey`, or
     * returns `None` without running when another process holds it. Turn
     * starts for the same CLI wait while it runs.
     */
    readonly tryInstall: <A, E, R>(
      target: ProviderInstallTarget,
      install: (
        recordChildPid: (
          pid: number,
        ) => Effect.Effect<void, ProviderInstallLock.ProviderInstallLockError>,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | ProviderInstallLock.ProviderInstallLockError, R>;
    /** Whether this server, or any process holding an install lock, is installing now. */
    readonly installing: Effect.Effect<boolean>;
    /** Completes once nothing is installing the CLI that `instanceId` runs. */
    readonly awaitInstance: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
    /** The CLI `instanceId` runs, or null when it has no installer styal can run. */
    readonly targetFor: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ProviderInstallTarget | null>;
    /** Installs this server is running now; a restart would cut them off. */
    readonly installsInFlight: Effect.Effect<number>;
  }
>()("@styal/cli/provider/ProviderInstallGate") {}

/** @public */
export const make = Effect.gen(function* () {
  const lock = yield* ProviderInstallLock.ProviderInstallLock;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const localInstalls = yield* Ref.make<ReadonlySet<LocalInstall>>(new Set());

  // A lookup for the caller's operation, which owns the span; `awaitInstance` repeats it
  // on every poll, and the auto-updater's busy check once per instance.
  const targetFor = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance === undefined) return null;
    const capabilities = yield* instance.snapshot.resolveMaintenance();
    return capabilities.update === null
      ? null
      : { lockKey: capabilities.update.lockKey, packageName: capabilities.packageName };
  });

  const tryInstall: ProviderInstallGate["Service"]["tryInstall"] = (target, install) =>
    lock.tryRun(target.lockKey, (recordChildPid) =>
      Effect.acquireUseRelease(
        Deferred.make<void>().pipe(
          Effect.map((done): LocalInstall => ({ target, done })),
          Effect.tap((entry) => Ref.update(localInstalls, (set) => new Set(set).add(entry))),
        ),
        () => install(recordChildPid),
        (entry) =>
          Ref.update(localInstalls, (set) => {
            const next = new Set(set);
            next.delete(entry);
            return next;
          }).pipe(Effect.andThen(Deferred.succeed(entry.done, undefined))),
      ),
    );

  // A failed lock read counts as free: a turn must not hang on an unreadable cache directory.
  const remoteHeld = (read: Effect.Effect<boolean, ProviderInstallLock.ProviderInstallLockError>) =>
    read.pipe(Effect.orElseSucceed(() => false));

  const installing = Effect.gen(function* () {
    if ((yield* Ref.get(localInstalls)).size > 0) return true;
    return yield* remoteHeld(lock.anyHeld);
  });

  // Runs inside the turn start's install-wait span, and only while an install is in progress.
  const awaitInstance = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    let logged = false;
    while (yield* installing) {
      const target = yield* targetFor(instanceId);
      if (target === null) return;
      const local = [...(yield* Ref.get(localInstalls))];
      const same = local.find((entry) => sameTarget(entry.target, target));
      // While this server installs under the key, the lock is its own.
      const remote =
        same === undefined &&
        !local.some((entry) => entry.target.lockKey === target.lockKey) &&
        (yield* remoteHeld(lock.keyHeld(target.lockKey)));
      if (same === undefined && !remote) return;
      if (!logged) {
        logged = true;
        yield* Effect.logInfo("Turn start is waiting for a provider update to finish", {
          instanceId,
          lockKey: target.lockKey,
        });
      }
      yield* same === undefined
        ? Effect.sleep(REMOTE_INSTALL_POLL_INTERVAL)
        : Deferred.await(same.done);
    }
  });

  return ProviderInstallGate.of({
    tryInstall,
    installing,
    awaitInstance,
    targetFor,
    installsInFlight: Ref.get(localInstalls).pipe(Effect.map((set) => set.size)),
  });
});

/**
 * One instance per server: the runner, turn starts and host activity must
 * share its in-process state, so every caller provides this same layer.
 */
export const layer = Layer.effect(ProviderInstallGate, make).pipe(
  Layer.provide(ProviderInstallLock.layer),
);
