import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerRemoveFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRemoveFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRemoveFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("publishes a complete secret without replacing a concurrent winner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "clerk-cli-key-publication-",
        });
        const opened = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let first = true;
        const delayedFs = {
          ...fs,
          open: (...args: Parameters<typeof fs.open>) =>
            fs.open(...args).pipe(
              Effect.map((file) => {
                if (!first) return file;
                first = false;
                return {
                  ...file,
                  sync: file.sync,
                  writeAll: (bytes: Uint8Array) =>
                    Deferred.succeed(opened, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(file.writeAll(bytes)),
                    ),
                };
              }),
            ),
        };
        const store = yield* ServerSecretStore.make.pipe(
          Effect.provideService(FileSystem.FileSystem, delayedFs),
          Effect.provide(ServerConfig.layerTest(process.cwd(), directory)),
        );
        const firstAttempt = yield* Effect.result(
          store.create("proof-key", Uint8Array.of(1, 2, 3)),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(opened);
        assert.isTrue(Option.isNone(yield* store.get("proof-key")));
        yield* store.create("proof-key", Uint8Array.of(4, 5, 6));
        yield* Deferred.succeed(release, undefined);
        const outcome = yield* Fiber.join(firstAttempt);
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag === "Failure")
          assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(outcome.failure));
        assert.deepEqual(Array.from(Option.getOrThrow(yield* store.get("proof-key"))), [4, 5, 6]);
        const entries = yield* fs.readDirectory(store.directory!);
        assert.deepEqual(entries, ["proof-key.bin"]);
        const stat = yield* fs.stat(path.join(store.directory!, "proof-key.bin"));
        assert.equal(stat.mode & 0o777, 0o600);
      }),
    ),
  );

  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect.each(["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP", "ENOSYS"])(
    "falls back to exclusive creation when hard links fail with %s",
    (code) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const chmodCalls: Array<string> = [];
        const store = yield* ServerSecretStore.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            link: (from) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: code === "EPERM" ? "PermissionDenied" : "Unknown",
                  module: "FileSystem",
                  method: "link",
                  pathOrDescriptor: from,
                  cause: Object.assign(new Error("Hard links unavailable"), { code }),
                }),
              ),
            chmod: (file, mode) =>
              fs.chmod(file, mode).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (mode === 0o600) chmodCalls.push(file);
                  }),
                ),
              ),
          }),
        );
        const winner = yield* store.getOrCreateRandom("fallback-key", 32);
        assert.lengthOf(winner, 32);
        assert.deepEqual(Option.getOrThrow(yield* store.get("fallback-key")), winner);
        const loser = yield* Effect.flip(store.create("fallback-key", Uint8Array.of(9)));
        assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(loser));
        assert.deepEqual(Option.getOrThrow(yield* store.get("fallback-key")), winner);
        const published = path.join(store.directory!, "fallback-key.bin");
        assert.include(chmodCalls, published);
        assert.equal((yield* fs.stat(published)).mode & 0o777, 0o600);
        assert.deepEqual(yield* fs.readDirectory(store.directory!), ["fallback-key.bin"]);
        const contenders = [Uint8Array.of(1, 2), Uint8Array.of(3, 4)];
        const outcomes = yield* Effect.forEach(
          contenders,
          (bytes) => Effect.result(store.create("raced-key", bytes)),
          { concurrency: "unbounded" },
        );
        assert.equal(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
        const winningIndex = outcomes.findIndex((outcome) => outcome._tag === "Success");
        assert.deepEqual(
          Option.getOrThrow(yield* store.get("raced-key")),
          contenders[winningIndex],
        );
        for (const outcome of outcomes) {
          if (outcome._tag === "Failure") {
            assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(outcome.failure));
          }
        }
      }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("an existing hard-link winner never enters the fallback write path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let directOpens = 0;
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (file, options) => {
            if (file.endsWith(".bin")) directOpens += 1;
            return fs.open(file, options);
          },
        }),
      );
      yield* store.create("winner", Uint8Array.of(1, 2, 3));
      const error = yield* Effect.flip(store.create("winner", Uint8Array.of(4, 5, 6)));
      assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(error));
      assert.equal(directOpens, 0);
      assert.deepEqual(Option.getOrThrow(yield* store.get("winner")), Uint8Array.of(1, 2, 3));
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect(
    "sweeps old temporary links for this secret while keeping fresh and unrelated files",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("20 minutes");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* ServerSecretStore.make;
        yield* store.create("proof-key", Uint8Array.of(1, 2, 3));
        const published = path.join(store.directory!, "proof-key.bin");
        const stale = `${published}.crashed.tmp`;
        const fresh = `${published}.active.tmp`;
        const unrelated = path.join(store.directory!, "other-key.bin.crashed.tmp");
        yield* fs.link(published, stale);
        yield* fs.writeFile(fresh, Uint8Array.of(4));
        yield* fs.writeFile(unrelated, Uint8Array.of(5));
        const now = yield* Clock.currentTimeMillis;
        const old = (now - 10 * 60_000) / 1_000;
        yield* fs.utimes(stale, old, old);
        yield* fs.utimes(unrelated, old, old);
        yield* fs.utimes(fresh, now / 1_000, now / 1_000);
        assert.isTrue(
          ServerSecretStore.isSecretAlreadyExistsError(
            yield* Effect.flip(store.create("proof-key", Uint8Array.of(9))),
          ),
        );
        assert.isFalse(yield* fs.exists(stale));
        assert.isTrue(yield* fs.exists(fresh));
        assert.isTrue(yield* fs.exists(unrelated));
        assert.deepEqual(Option.getOrThrow(yield* store.get("proof-key")), Uint8Array.of(1, 2, 3));
        yield* store.remove("proof-key");
        assert.isFalse(yield* fs.exists(published));
        assert.isFalse(yield* fs.exists(stale));
      }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("creates a secret even when stale temporary-file cleanup fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: (file) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readDirectory",
                pathOrDescriptor: file,
              }),
            ),
        }),
      );
      yield* store.create("proof-key", Uint8Array.of(1));
      assert.deepEqual(Option.getOrThrow(yield* store.get("proof-key")), Uint8Array.of(1));
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () =>
    Effect.gen(function* () {
      const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
      const layerRecordingFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          return {
            ...fileSystem,
            makeDirectory: () => Effect.void,
            writeFile: () => Effect.void,
            rename: () => Effect.void,
            chmod: (path, mode) =>
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const secretStore = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(layerServerConfig()),
            Layer.provideMerge(layerRecordingFileSystem),
          ),
        ),
      );

      yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));

      assert.isTrue(
        chmodCalls.some((call) => call.mode === 0o700 && /[\\/]secrets$/.test(call.path)),
      );
      assert.isAtLeast(chmodCalls.filter((call) => call.mode === 0o600).length, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRemoveFailureSecretStore())),
  );
});
