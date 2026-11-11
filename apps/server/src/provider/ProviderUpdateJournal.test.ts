import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { ServerConfig } from "../config.ts";
import * as Journal from "./ProviderUpdateJournal.ts";

it.layer(Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto))(
  "ProviderUpdateJournal",
  (it) => {
    it.effect(
      "two writers preserve history during startup rotation and share the running size cap",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const scratch = new URL("../../../../.scratch/", import.meta.url).pathname;
          yield* fs.makeDirectory(scratch, { recursive: true });
          const logsDir = yield* fs.makeTempDirectoryScoped({
            directory: scratch,
            prefix: "provider-update-two-writers-",
          });
          const active = `${logsDir}/provider-updates.ndjson`;
          const history = `synthetic history\n${" ".repeat(512 * 1024)}`;
          yield* fs.writeFileString(active, history);
          for (let index = 0; index < 4; index++)
            yield* fs.writeFileString(
              `${active}.1000-01-01.${index}`,
              `old synthetic archive ${index}`,
            );
          const writes = yield* Queue.unbounded<void>();
          const reads = yield* Queue.unbounded<void>();
          const bothRead = yield* Deferred.make<void>();
          let startupReads = 0;
          const observedFs: FileSystem.FileSystem = {
            ...fs,
            stat: (file) =>
              fs.stat(file).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (file !== active) return;
                    startupReads++;
                    if (startupReads <= 2) {
                      if (startupReads === 2) yield* Deferred.succeed(bothRead, undefined);
                      yield* Deferred.await(bothRead);
                    }
                    yield* Queue.offer(reads, undefined);
                  }),
                ),
              ),
            writeFile: (file, bytes, options) =>
              fs.writeFile(file, bytes, options).pipe(
                Effect.tap(() => {
                  assert.strictEqual(options?.flag, "a");
                  return Queue.offer(writes, undefined);
                }),
              ),
          };
          const build = Layer.build(Journal.layer).pipe(
            Effect.provideService(ServerConfig, { logsDir } as never),
            Effect.provideService(FileSystem.FileSystem, observedFs),
            Effect.map((context) => Context.get(context, Journal.ProviderUpdateJournal)),
          );
          const first = yield* build;
          const second = yield* build;
          yield* first.record("writer-a", "codex", { outcome: "started" });
          yield* second.record("writer-b", "claudeCode", { outcome: "finished" });
          yield* Queue.take(writes);
          yield* Queue.take(writes);
          const files = yield* fs.readDirectory(logsDir);
          assert.isAtMost(files.length, 5);
          const content = (yield* Effect.forEach(files, (file) =>
            fs.readFileString(`${logsDir}/${file}`),
          )).join("");
          assert.strictEqual(content.split(history).length - 1, 1);
          assert.strictEqual(content.split('"instanceId":"writer-a"').length - 1, 1);
          assert.strictEqual(content.split('"instanceId":"writer-b"').length - 1, 1);
          // Simulate a second server filling the active file after both workers initialized.
          const full = "x".repeat(1024 * 1024);
          yield* fs.writeFileString(active, full);
          yield* Queue.takeAll(reads);
          yield* first.record("writer-a", "codex", { outcome: "started" });
          yield* second.record("writer-b", "claudeCode", { outcome: "started" });
          yield* Queue.take(reads);
          yield* Queue.take(reads);
          assert.strictEqual(yield* fs.readFileString(active), full);
          assert.deepStrictEqual((yield* fs.readDirectory(logsDir)).sort(), files.sort());
        }),
    );
  },
);
