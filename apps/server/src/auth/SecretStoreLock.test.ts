// @effect-diagnostics nodeBuiltinImport:off - A child process verifies filesystem exclusion.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { withSecretStoreLock } from "./SecretStoreLock.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const lockModule = NodeModule.createRequire(import.meta.url).resolve("proper-lockfile");
const probe = (directory: string) =>
  Effect.promise(async () => {
    const { stdout } = await execFile(process.execPath, [
      "-e",
      `
    const { lock } = require(process.argv[1]);
    lock(process.argv[2], { realpath: false }).then(async release => {
      await release(); process.stdout.write('acquired');
    }, error => {
      if (error.code === 'ELOCKED') process.stdout.write('blocked');
      else { console.error(error); process.exitCode = 1; }
    });
  `,
      lockModule,
      NodePath.join(directory, "cloud-cli-session.bin"),
    ]);
    return stdout;
  });

it.live("excludes another process and releases the credential lease after interruption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "clerk-cli-lock-",
      });
      assert.equal(
        yield* withSecretStoreLock(directory, "cloud-cli-session", probe(directory)),
        "blocked",
      );
      assert.equal(yield* probe(directory), "acquired");
      const entered = yield* Deferred.make<void>();
      const operation = yield* withSecretStoreLock(
        directory,
        "cloud-cli-session",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.equal(yield* probe(directory), "blocked");
      yield* Fiber.interrupt(operation);
      assert.equal(yield* probe(directory), "acquired");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
