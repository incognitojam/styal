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
      "two writers preserve history during concurrent rotation with bounded overshoot",
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
          const bothRead = yield* Deferred.make<void>();
          let startupReads = 0;
          let nearCapReads = 0;
          let atCap = false;
          const bothNearCap = yield* Deferred.make<void>();
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
                    if (atCap && nearCapReads++ < 2) {
                      if (nearCapReads === 2) yield* Deferred.succeed(bothNearCap, undefined);
                      yield* Deferred.await(bothNearCap);
                    }
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
          const [first, second] = yield* Effect.all([build, build], { concurrency: "unbounded" });
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
          const nearCap = "x".repeat(1024 * 1024 - 200);
          yield* fs.writeFileString(active, nearCap);
          atCap = true;
          yield* first.record("writer-a", "codex", { outcome: "started" });
          yield* second.record("writer-b", "claudeCode", { outcome: "started" });
          yield* Queue.take(writes);
          yield* Queue.take(writes);
          const overshot = Number((yield* fs.stat(active)).size);
          assert.isAbove(overshot, 1024 * 1024);
          assert.isAtMost(overshot, 1024 * 1024 + 2 * 4096);
          yield* first.record("writer-a", "codex", { outcome: "failed", reason: "after_rotation" });
          yield* second.record("writer-b", "claudeCode", {
            outcome: "failed",
            reason: "after_rotation",
          });
          yield* Queue.take(writes);
          yield* Queue.take(writes);
          const retained = yield* fs.readDirectory(logsDir);
          const contents = yield* Effect.forEach(retained, (file) =>
            fs.readFileString(`${logsDir}/${file}`),
          );
          assert.strictEqual(contents.join("").split(nearCap).length - 1, 1);
          assert.strictEqual(contents.join("").split('"reason":"after_rotation"').length - 1, 2);
          assert.isAtMost(
            contents.reduce(
              (total, content) => total + new TextEncoder().encode(content).length,
              0,
            ),
            5 * 1024 * 1024 + 2 * 4096,
          );
        }),
    );
    it.effect(
      "a running writer survives a failed write, rolls over full files, and retains recent failures within its budget",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const scratch = new URL("../../../../.scratch/", import.meta.url).pathname;
          yield* fs.makeDirectory(scratch, { recursive: true });
          const logsDir = yield* fs.makeTempDirectoryScoped({
            directory: scratch,
            prefix: "provider-update-running-",
          });
          const writes = yield* Queue.unbounded<void>();
          let failNextWrite = true;
          const observedFs: FileSystem.FileSystem = {
            ...fs,
            writeFile: (file, bytes, options) => {
              // Writing to the directory itself fails like a full or read-only disk would.
              const target = failNextWrite ? logsDir : file;
              failNextWrite = false;
              return fs.writeFile(target, bytes, options).pipe(
                Effect.tap(() => Queue.offer(writes, undefined)),
                Effect.tapError(() => Queue.offer(writes, undefined)),
              );
            },
          };
          const context = yield* Layer.build(Journal.layer).pipe(
            Effect.provideService(ServerConfig, { logsDir } as never),
            Effect.provideService(FileSystem.FileSystem, observedFs),
          );
          const journal = Context.get(context, Journal.ProviderUpdateJournal);
          yield* journal.record("synthetic-provider", "codex", { outcome: "started" });
          yield* Queue.take(writes);
          for (let index = 0; index < 1600; index++) {
            yield* journal.record("synthetic-provider", "codex", {
              outcome: "skipped",
              reason: "x".repeat(3800),
            });
            yield* Queue.take(writes);
          }
          yield* journal.record("synthetic-provider", "codex", {
            outcome: "failed",
            reason: "recent_failure",
          });
          yield* Queue.take(writes);
          const files = yield* fs.readDirectory(logsDir);
          assert.lengthOf(files, 5);
          const bytes = yield* Effect.forEach(files, (file) =>
            fs.stat(`${logsDir}/${file}`).pipe(Effect.map((stat) => Number(stat.size))),
          );
          assert.isAtMost(
            bytes.reduce((total, size) => total + size, 0),
            5 * 1024 * 1024,
          );
          assert.include(
            yield* fs.readFileString(`${logsDir}/provider-updates.ndjson`),
            '"reason":"recent_failure"',
          );
        }),
    );
  },
);
