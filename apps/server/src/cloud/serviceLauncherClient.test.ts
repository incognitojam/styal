import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_BACKUP_CLAIM_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
} from "./serviceProtocol.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";

class FakeLauncherProcess {
  readonly connected: boolean;
  readonly env: Record<string, string | undefined>;
  readonly sent: ServiceLauncherChildMessage[] = [];
  readonly #listeners = new Map<string, Set<(...args: ReadonlyArray<unknown>) => void>>();

  constructor(context: unknown, connected = true) {
    this.connected = connected;
    this.env = { [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) };
  }

  send = (message: ServiceLauncherChildMessage, callback?: (error: Error | null) => void) => {
    this.sent.push(message);
    callback?.(null);
    return true;
  };

  on = (event: "message" | "disconnect", listener: (...args: ReadonlyArray<unknown>) => void) => {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  };

  off = (event: "message" | "disconnect", listener: (...args: ReadonlyArray<unknown>) => void) => {
    this.#listeners.get(event)?.delete(listener);
  };

  emit(message: ServiceLauncherParentMessage) {
    for (const listener of this.#listeners.get("message") ?? []) listener(message);
  }
}

const makeClient = (host: FakeLauncherProcess, currentVersion: string) =>
  ServiceLauncherClient.make({ currentVersion }).pipe(
    Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, host),
    Effect.provideService(HostProcess.Environment, host.env),
    Effect.provide(NodeServices.layer),
  );

it.effect.each([SERVICE_LAUNCHER_PROTOCOL])(
  "waits for a protocol-%i launcher to durably commit the trial update ID, then moves owned launchers",
  (protocol) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-trial-" });
      const baseDir = path.join(root, ".styal");
      const exe = (version: string) =>
        path.join(baseDir, "runtime/styal-executable/versions", version, "styal");
      const installed = path.join(root, ".local/bin/styal");
      for (const file of [exe("1.0.0"), exe("1.1.0")]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(installed), { recursive: true });
      yield* fs.symlink(exe("1.0.0"), installed);

      const pending = {
        id: "update-1",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending" as const,
      };
      const host = new FakeLauncherProcess({ protocol, childVersion: "1.1.0", update: pending });
      host.env["HOME"] = root;
      const client = yield* makeClient(host, "1.1.0");
      const prepared = yield* Effect.forkChild(client.prepareTrial({ baseDir }), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      expect(host.sent).toEqual([{ type: "prepared", updateId: "update-1" }]);
      assert.equal(yield* fs.readLink(installed), exe("1.0.0"));

      const committed = {
        id: pending.id,
        fromVersion: pending.fromVersion,
        targetVersion: pending.targetVersion,
        status: "committed" as const,
      };
      host.emit({ type: "committed", updateId: committed.id });
      expect(yield* Fiber.join(prepared)).toEqual(committed);
      assert.equal(yield* fs.readLink(installed), exe("1.1.0"));

      // A later start replays the stored outcome; user pins made since then stay put.
      yield* fs.remove(installed);
      yield* fs.symlink(exe("1.0.0"), installed);
      const restarted = new FakeLauncherProcess({
        protocol,
        childVersion: "1.1.0",
        update: committed,
      });
      restarted.env["HOME"] = root;
      const restartedClient = yield* makeClient(restarted, "1.1.0");
      expect(yield* restartedClient.prepareTrial({ baseDir })).toEqual(committed);
      assert.equal(yield* fs.readLink(installed), exe("1.0.0"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["writable", "unwritable"] as const)(
  "returns the accepted update ID with a %s backup claim",
  (claimState) =>
    Effect.gen(function* () {
      const host = new FakeLauncherProcess({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        childVersion: "1.0.0",
      });
      const client = yield* makeClient(host, "1.0.0");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-accepted-claim-" });
      yield* fs.makeDirectory(path.join(baseDir, "userdata"));
      const claim = path.join(baseDir, "userdata", SERVICE_BACKUP_CLAIM_FILE);
      if (claimState === "unwritable") yield* fs.makeDirectory(claim);
      const sent = Promise.withResolvers<void>();
      const send = host.send;
      host.send = (message, callback) => {
        const result = send(message, callback);
        sent.resolve();
        return result;
      };
      const requested = yield* Effect.forkChild(
        client.requestUpdate({
          targetVersion: "1.1.0",
          dbPath: path.join(baseDir, "database.sqlite"),
          baseDir,
        }),
        { startImmediately: true },
      );
      yield* Effect.promise(() => sent.promise);
      if (claimState === "writable") assert.isFalse(yield* fs.exists(claim));
      host.emit({
        type: "update-accepted",
        updateId: "launcher-id",
      });
      expect(yield* Fiber.join(requested)).toBe("launcher-id");
      if (claimState === "writable") assert.equal(yield* fs.readFileString(claim), "launcher-id");
      else assert.isTrue((yield* fs.stat(claim)).type === "Directory");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves a launcher rejection as a distinct error", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.0.0",
    });
    const client = yield* makeClient(host, "1.0.0");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-accepted-claim-" });
    yield* fs.makeDirectory(path.join(baseDir, "userdata"));
    const claim = path.join(baseDir, "userdata", SERVICE_BACKUP_CLAIM_FILE);
    const sent = Promise.withResolvers<void>();
    const send = host.send;
    host.send = (message, callback) => {
      const result = send(message, callback);
      sent.resolve();
      return result;
    };
    const requested = yield* Effect.forkChild(
      client.requestUpdate({
        targetVersion: "1.1.0",
        dbPath: path.join(baseDir, "database.sqlite"),
        baseDir,
      }),
      { startImmediately: true },
    );
    yield* Effect.promise(() => sent.promise);
    host.emit({ type: "update-rejected", reason: "requires local update" });
    expect(yield* Fiber.join(requested).pipe(Effect.flip)).toMatchObject({
      _tag: "ServiceLauncherRejectedError",
      targetVersion: "1.1.0",
      reason: "requires local update",
    });
    assert.isFalse(yield* fs.exists(claim));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("stops the server when the launcher asks over IPC", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.0.0",
    });
    const stopped = yield* Effect.forkChild(
      ServiceLauncherClient.awaitServiceLauncherStop({ currentVersion: "1.0.0" }).pipe(
        Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, host),
        Effect.provideService(HostProcess.Environment, host.env),
      ),
      { startImmediately: true },
    );
    host.emit({ type: "stop" });
    yield* Fiber.join(stopped);
  }),
);

it.effect("rejects contradictory trial context instead of leaving activation closed", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.1.0",
      update: {
        id: "update-1",
        fromVersion: "1.0.0",
        targetVersion: "1.2.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    });
    const error = yield* makeClient(host, "1.1.0").pipe(Effect.flip);
    expect(error.message).toBe("The service launcher supplied invalid startup context.");
  }),
);

// styal's protocol 3 is the old npm layout, which this runtime cannot run under.
it.effect("refuses a protocol-3 launcher's startup context", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({ protocol: 3, childVersion: "1.1.0" });
    const error = yield* makeClient(host, "1.1.0").pipe(Effect.flip);
    expect(error.message).toBe("The service launcher supplied invalid startup context.");
  }),
);

it.effect("ignores launcher context inherited without an IPC channel", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess(
      { protocol: SERVICE_LAUNCHER_PROTOCOL, childVersion: "1.0.0" },
      false,
    );
    const client = yield* makeClient(host, "1.1.0");
    const error = yield* client
      .requestUpdate({
        targetVersion: "1.2.0",
        dbPath: "/synthetic/database.sqlite",
        baseDir: "/synthetic",
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ServiceLauncherClientError", operation: "unmanaged" });
    expect(host.sent).toEqual([]);
  }),
);

it.layer(NodeServices.layer)("self-update launchers", (it) => {
  it.effect.each(["environment", "registry"] as const)(
    "updates custom install and PATH launchers via %s, including versions older than fromVersion",
    (discovery) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
        const baseDir = path.join(root, ".styal");
        const exe = (version: string) =>
          path.join(baseDir, "runtime/styal-executable/versions", version, "styal");
        const installed = path.join(root, "custom/bin/styal");
        const onPath = path.join(root, "bin/styal");
        for (const file of [exe("1.0.0"), exe("1.5.0"), exe("2.0.0")]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "");
        }
        yield* fs.makeDirectory(path.dirname(installed), { recursive: true });
        yield* fs.symlink(exe("1.5.0"), installed);
        yield* fs.makeDirectory(path.dirname(onPath), { recursive: true });
        yield* fs.symlink(exe("1.0.0"), onPath);

        if (discovery === "registry") {
          yield* fs.writeFileString(path.join(baseDir, "runtime/launchers"), `${installed}\n`);
        }

        yield* ServiceLauncherClient.repointLaunchers({ baseDir, targetVersion: "2.0.0" }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            ...(discovery === "environment"
              ? { STYAL_INSTALL_BIN_DIR: path.dirname(installed) }
              : {}),
            PATH: path.dirname(onPath),
          }),
        );

        assert.equal(yield* fs.readLink(installed), exe("2.0.0"));
        assert.equal(yield* fs.readLink(onPath), exe("2.0.0"));
      }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("still moves the PATH launcher when the install bin one cannot be rewritten", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const baseDir = path.join(root, ".styal");
      const exe = (version: string) =>
        path.join(baseDir, "runtime/styal-executable/versions", version, "styal");
      const installed = path.join(root, ".local/bin/styal");
      const onPath = path.join(root, "bin/styal");
      for (const file of [exe("1.0.0"), exe("2.0.0")]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      for (const link of [installed, onPath]) {
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(exe("1.0.0"), link);
      }
      const warnings: unknown[] = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const failingFs = FileSystem.FileSystem.of({
        ...fs,
        rename: (source, destination) =>
          destination === installed
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: destination,
                  }),
                ),
              )
            : fs.rename(source, destination),
      });

      yield* ServiceLauncherClient.repointLaunchers({ baseDir, targetVersion: "2.0.0" }).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: root,
          PATH: path.dirname(onPath),
        }),
        Effect.provideService(FileSystem.FileSystem, failingFs),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );

      assert.lengthOf(warnings, 1);
      assert.include(JSON.stringify(warnings), installed);
      assert.equal(yield* fs.readLink(installed), exe("1.0.0"));
      assert.equal(yield* fs.readLink(onPath), exe("2.0.0"));
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves unowned install files and PATH symlinks untouched after self-update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const baseDir = path.join(root, ".styal");
      const installed = path.join(root, ".local/bin/styal");
      const onPath = path.join(root, "bin/styal");
      const foreign = path.join(root, "other-home/runtime/styal-executable/versions/1.0.0/styal");
      const target = path.join(baseDir, "runtime/styal-executable/versions/2.0.0/styal");
      for (const file of [installed, foreign, target]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "user-owned file");
      }
      yield* fs.makeDirectory(path.dirname(onPath), { recursive: true });
      yield* fs.symlink(foreign, onPath);

      yield* ServiceLauncherClient.repointLaunchers({ baseDir, targetVersion: "2.0.0" }).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: root,
          PATH: path.dirname(onPath),
        }),
      );

      assert.equal(yield* fs.readFileString(installed), "user-owned file");
      assert.equal(yield* fs.readLink(onPath), foreign);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});
