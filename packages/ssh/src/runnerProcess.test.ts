import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { buildRemoteLaunchScript, buildRemoteT3RunnerScript } from "./tunnel.ts";

const Started = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  args: Schema.Array(Schema.String),
});
const decodeStarted = Schema.decodeUnknownSync(Schema.fromJsonString(Started));
const encodeRuntime = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ pid: Schema.Number, port: Schema.Number, origin: Schema.String }),
  ),
);
const decodeLaunch = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      remotePort: Schema.Number,
      serverKind: Schema.Literals(["managed", "external"]),
    }),
  ),
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote runner process ownership",
  () => {
    it.live.each(["managed", "external"] as const)(
      "preserves %s ownership when the server publishes its default runtime record",
      (ownership) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "styal-reconnect-" });
          const stateDir = path.join(fixture, ".styal/ssh-launch/fixture");
          const userdata = path.join(fixture, ".styal/userdata");
          yield* fs.makeDirectory(stateDir, { recursive: true });
          yield* fs.makeDirectory(userdata, { recursive: true });
          const child = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `import * as http from "node:http";
const server = http.createServer((_request, response) => response.end("ready"));
process.on("SIGTERM", () => server.close());
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ pid: process.pid, port: server.address().port, args: [] }) + "\\n");
});`,
              ],
              { cwd: fixture, detached: false },
            ),
          );
          yield* Effect.addFinalizer(() =>
            child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore),
          );
          const started = decodeStarted(
            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.take(1),
              Stream.mkString,
            ),
          );
          yield* fs.writeFileString(
            path.join(userdata, "server-runtime.json"),
            encodeRuntime({
              pid: started.pid,
              port: started.port,
              origin: `http://127.0.0.1:${started.port}`,
            }),
          );
          const runner = { nodeScriptPath: path.join(fixture, "fixture-cli.mjs") };
          yield* fs.writeFileString(
            path.join(stateDir, "run-styal.sh"),
            `${buildRemoteT3RunnerScript(runner)}\n`,
          );
          if (ownership === "managed") {
            yield* fs.writeFileString(path.join(stateDir, "pid"), `${started.pid}\n`);
            yield* fs.writeFileString(path.join(stateDir, "port"), `${started.port}\n`);
            yield* fs.writeFileString(path.join(stateDir, "managed"), "managed\n");
          }
          const reconnect = yield* spawner.spawn(
            ChildProcess.make("/bin/sh", ["-s", "--", "fixture"], {
              cwd: fixture,
              env: {
                HOME: fixture,
                PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
              },
              stdin: Stream.make(new TextEncoder().encode(buildRemoteLaunchScript(runner))),
            }),
          );
          const result = yield* Effect.all(
            {
              stdout: reconnect.stdout.pipe(Stream.decodeText(), Stream.mkString),
              stderr: reconnect.stderr.pipe(Stream.decodeText(), Stream.mkString),
              exitCode: reconnect.exitCode,
            },
            { concurrency: "unbounded" },
          );
          assert.equal(result.exitCode, 0, result.stderr);
          assert.deepEqual(decodeLaunch(result.stdout), {
            remotePort: started.port,
            serverKind: ownership,
          });
          assert.isTrue(yield* child.isRunning);
          assert.equal(
            (yield* fs.readFileString(path.join(stateDir, "managed"))).trim(),
            ownership,
          );
          assert.equal(yield* fs.exists(path.join(stateDir, "pid")), ownership === "managed");
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
