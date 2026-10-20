// @effect-diagnostics nodeBuiltinImport:off - exercises concurrent real CLI subprocesses.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ensureAgentDeviceShim } from "./AgentDeviceShim.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  readAgentDeviceConfig,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("host-bound agent commands", () => {
  it.effect.skipIf(windowsHost)("runs the desktop shim and direct launcher in Node mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-node-mode-" });
      const dir = path.join(temp, "desktop runtime with spaces");
      yield* fs.makeDirectory(dir);
      const executable = path.join(dir, "desktop");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      yield* fs.writeFileString(
        executable,
        `#!/bin/sh
if [ "$ELECTRON_RUN_AS_NODE" != "1" ]; then
  printf '%s\\n' 'Desktop runtime requires Node mode' >&2
  exit 73
fi
exec ${quote(process.execPath)} "$@"
`,
      );
      yield* fs.chmod(executable, 0o755);
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(
        entryPath,
        `console.log(JSON.stringify({ args: process.argv.slice(2), nodeMode: process.env.ELECTRON_RUN_AS_NODE }));`,
      );
      const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir }).pipe(
        Effect.provideService(HostProcess.ExecutablePath, executable),
        Effect.provideService(HostProcess.IsExecutable, false),
      );
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: "0" };
      const args = ["snapshot", "--config", "synthetic-host.json", "--session", "test-session"];
      for (const command of [
        { file: path.join(shim, "agent-device"), args },
        { file: process.execPath, args: [path.join(shim, "agent-device-launcher.mjs"), ...args] },
      ]) {
        const result = yield* Effect.promise(() => exec(command.file, command.args, { env }));
        expect(yield* decodeOutput(result.stdout)).toEqual({
          args,
          nodeMode: "1",
        });
        expect(result.stderr).toBe("");
      }
      for (const argument of ["help", "--version"]) {
        const result = yield* Effect.promise(() =>
          exec(path.join(shim, "agent-device"), [argument], { env }),
        );
        expect(yield* decodeOutput(result.stdout)).toEqual({
          args: [argument],
          nodeMode: "1",
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!windowsHost)("runs the Windows wrapper in Node mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-node-mode-" });
      const dir = path.join(temp, "desktop runtime with spaces");
      yield* fs.makeDirectory(dir);
      const guard = path.join(dir, "node-mode-guard.cjs");
      yield* fs.writeFileString(
        guard,
        `if (process.env.ELECTRON_RUN_AS_NODE !== "1") throw new Error("Desktop runtime requires Node mode");`,
      );
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(entryPath, `console.log(process.env.ELECTRON_RUN_AS_NODE);`);
      const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir });
      const result = yield* Effect.promise(() =>
        exec("cmd.exe", ["/d", "/s", "/c", `""${path.join(shim, "agent-device.cmd")}" --help"`], {
          windowsVerbatimArguments: true,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "0",
            // NODE_OPTIONS treats backslashes as escapes, including in quoted paths.
            NODE_OPTIONS: `--require "${guard.replaceAll("\\", "/")}"`,
          },
        }),
      );
      expect(result.stdout.trim()).toBe("1");
      expect(result.stderr).toBe("");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "runs both desktop hops as Node with a stripped environment, preserving arguments and exit code",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-target-" });
        const dir = path.join(temp, "quotes '\" $HOME `literal`");
        yield* fs.makeDirectory(dir);
        const desktopApp = path.join(dir, "styal");
        // Dropping Node mode after checking it forces each hop to set it independently.
        yield* fs.writeFileString(
          desktopApp,
          `#!/bin/sh
if [ "\${ELECTRON_RUN_AS_NODE:-}" != "1" ]; then
  echo "started the desktop app" >&2
  exit 134
fi
unset ELECTRON_RUN_AS_NODE
exec '${process.execPath.replaceAll("'", "'\"'\"'")}' "$@"
`,
        );
        yield* fs.chmod(desktopApp, 0o755);
        const entryPath = path.join(dir, "cli.mjs");
        yield* fs.writeFileString(
          entryPath,
          "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;",
        );
        const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir }).pipe(
          Effect.provideService(HostProcess.ExecutablePath, desktopApp),
          Effect.provideService(HostProcess.IsExecutable, false),
        );
        const args = [
          "snapshot",
          "--config",
          path.join(dir, "config.json"),
          "--session",
          "a!b!c",
          "",
        ];
        yield* Effect.promise(() =>
          expect(
            exec(path.join(shim, "agent-device"), args, {
              env: { PATH: process.env.PATH ?? "", HOME: temp },
            }),
          ).rejects.toMatchObject({ code: 23, stdout: `${JSON.stringify(args)}\n`, stderr: "" }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs two hosts concurrently and only updates the reconnected host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-target-" });
      const platform = yield* HostProcess.Platform;
      const dir = path.join(
        temp,
        platform === "win32" ? "paths with spaces" : "quotes '\" $HOME `literal`",
      );
      yield* fs.makeDirectory(dir);
      const entryPath = path.join(dir, "cli.mjs");
      yield* fs.writeFileString(
        entryPath,
        `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
console.log(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
if (process.env.AGENT_DEVICE_DAEMON_BASE_URL) process.exit(2);`,
      );
      const shim = yield* ensureAgentDeviceShim({ entryPath, stateDir: dir });
      const files = yield* Effect.forEach(["mini", "android"], (host) =>
        agentDeviceConfigPath(dir, host, path),
      );
      for (const [index, file] of files.entries())
        yield* writeAgentDeviceConfig(file, {
          baseUrl: `http://127.0.0.1:${1000 + index}`,
          token: `token-${index}`,
        });
      const invoke = (file: string) =>
        exec(
          platform === "win32" ? process.execPath : path.join(shim, "agent-device"),
          [
            ...(platform === "win32" ? [path.join(shim, "agent-device-launcher.mjs")] : []),
            "snapshot",
            "--config",
            file,
            "--session",
            "test-session",
          ],
          { env: { ...process.env, AGENT_DEVICE_DAEMON_BASE_URL: "http://wrong-host" } },
        ).then((result) => JSON.parse(result.stdout));
      expect(yield* Effect.promise(() => Promise.all(files.map(invoke)))).toEqual([
        { daemonBaseUrl: "http://127.0.0.1:1000", daemonAuthToken: "token-0" },
        { daemonBaseUrl: "http://127.0.0.1:1001", daemonAuthToken: "token-1" },
      ]);
      const second = yield* fs.readFileString(files[1]!);
      yield* writeAgentDeviceConfig(files[0]!, {
        baseUrl: "http://127.0.0.1:2000",
        token: "new",
      });
      expect((yield* Effect.promise(() => invoke(files[0]!))).daemonAuthToken).toBe("new");
      expect(yield* fs.readFileString(files[1]!)).toBe(second);
      // Hosts with a daemon per device get a file per device, apart from the host's own.
      const perDevice = yield* Effect.forEach(["udid-1", "udid-2"], (device) =>
        agentDeviceConfigPath(dir, "eas", path, device),
      );
      expect(new Set([...perDevice, yield* agentDeviceConfigPath(dir, "eas", path)]).size).toBe(3);
      yield* writeAgentDeviceConfig(perDevice[0]!, { baseUrl: "http://eas.test", token: "udid-1" });
      expect(yield* readAgentDeviceConfig(dir, "eas", "udid-1")).toEqual({
        baseUrl: "http://eas.test",
        token: "udid-1",
      });
      expect(yield* readAgentDeviceConfig(dir, "eas", "udid-2")).toBeNull();
      expect(yield* readAgentDeviceConfig(dir, "android", "emulator-5554")).toEqual({
        baseUrl: "http://127.0.0.1:1001",
        token: "token-1",
      });
      expect(yield* agentDeviceSession("thread", "mini", "same-id")).not.toBe(
        yield* agentDeviceSession("thread", "android", "same-id"),
      );
      for (const args of [
        ["snapshot"],
        ["snapshot", "--config", files[0]!],
        ["snapshot", "--config", "help"],
        ["snapshot", "--config", files[0]!, "--session"],
      ]) {
        yield* Effect.promise(() =>
          expect(
            exec(process.execPath, [path.join(shim, "agent-device-launcher.mjs"), ...args]),
          ).rejects.toThrow("Call device_open first"),
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.ExecutablePath, "/packaged/t3"),
      Effect.provide(NodeServices.layer),
    ),
  );
});
