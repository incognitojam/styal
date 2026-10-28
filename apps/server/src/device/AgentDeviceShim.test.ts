// @effect-diagnostics nodeBuiltinImport:off - runs the generated launcher as a real subprocess.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  bindAgentDeviceLauncher,
  ensureAgentDeviceShim,
  pruneAgentDeviceLaunchers,
  releasedAgentSessionsPath,
} from "./AgentDeviceShim.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const encodeNames = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

describe("agent-device launcher", () => {
  it.effect("refuses a session that was handed back until it is handed out again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-shim-" });
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(entryPath, `console.log("ran");`);
      const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir });
      const run = (session: string) =>
        exec(process.execPath, [
          path.join(shim, "agent-device-launcher.mjs"),
          "snapshot",
          "--config",
          path.join(dir, "config.json"),
          "--session",
          session,
        ]);
      const released = releasedAgentSessionsPath(dir, path);
      yield* fs.makeDirectory(path.dirname(released), { recursive: true });
      yield* fs.writeFileString(released, encodeNames(["t3-released"]));

      yield* Effect.promise(() =>
        expect(run("t3-released")).rejects.toThrow("Call device_open again"),
      );
      expect((yield* Effect.promise(() => run("t3-current"))).stdout.trim()).toBe("ran");
      yield* fs.writeFileString(released, encodeNames([]));
      expect((yield* Effect.promise(() => run("t3-released"))).stdout.trim()).toBe("ran");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses one thread's launcher on a host session while another keeps it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-shim-" });
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(entryPath, `console.log("ran");`);
      const bind = (session: string) =>
        bindAgentDeviceLauncher({
          entryPath,
          stateDir: dir,
          session,
          targetArgs: ["--config", path.join(dir, "config.json"), "--session", "t3-lease"],
        });
      const run = (launcher: string, command: string) =>
        exec(process.execPath, [
          path.join(path.dirname(launcher), "agent-device-launcher.mjs"),
          command,
        ]);
      const handedBack = yield* bind("t3-thread-a");
      const holder = yield* bind("t3-thread-b");
      const released = releasedAgentSessionsPath(dir, path);
      yield* fs.makeDirectory(path.dirname(released), { recursive: true });
      yield* fs.writeFileString(released, encodeNames(["t3-thread-a"]));

      yield* Effect.promise(() =>
        expect(run(handedBack, "snapshot")).rejects.toThrow("Call device_open again"),
      );
      // Closing the shared session would end the lease for the thread that holds it now.
      yield* Effect.promise(() =>
        expect(run(handedBack, "close")).rejects.toThrow("Call device_open again"),
      );
      expect((yield* Effect.promise(() => run(holder, "snapshot"))).stdout.trim()).toBe("ran");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a released bound session, keeps its launcher, and lets close through", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-shim-" });
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(entryPath, `console.log("ran");`);
      const bind = (session: string) =>
        bindAgentDeviceLauncher({
          entryPath,
          stateDir: dir,
          session,
          targetArgs: ["--config", path.join(dir, "config.json"), "--session", session],
        });
      const launcher = yield* bind("t3-released");
      const closed = yield* bind("t3-closed");
      const run = (command: string) =>
        exec(process.execPath, [
          path.join(path.dirname(launcher), "agent-device-launcher.mjs"),
          command,
        ]);
      const released = releasedAgentSessionsPath(dir, path);
      yield* fs.writeFileString(released, encodeNames(["t3-released"]));

      yield* Effect.promise(() =>
        expect(run("snapshot")).rejects.toThrow("Call device_open again"),
      );
      expect((yield* Effect.promise(() => run("close"))).stdout.trim()).toBe("ran");

      yield* pruneAgentDeviceLaunchers({ stateDir: dir, live: new Set() });
      expect(yield* fs.exists(launcher)).toBe(true);
      expect(yield* fs.exists(closed)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
