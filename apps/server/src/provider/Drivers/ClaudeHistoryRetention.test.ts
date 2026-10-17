import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readClaudeHistoryRetention } from "./ClaudeHistoryRetention.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = path.resolve(import.meta.dirname, "../../../../../.scratch");
  yield* fs.makeDirectory(scratch, { recursive: true });
  const homePath = yield* fs.makeTempDirectoryScoped({
    directory: scratch,
    prefix: "provider-retention-test-",
  });
  return { fs, homePath, settingsPath: path.join(homePath, "settings.json") };
});

it.layer(NodeServices.layer)("readClaudeHistoryRetention", (it) => {
  it.effect("reports the default when the file or setting is absent", () =>
    Effect.gen(function* () {
      const { fs, homePath, settingsPath } = yield* fixture;
      assert.deepStrictEqual(yield* readClaudeHistoryRetention(homePath), {
        status: "default",
        days: 30,
        settingsPath,
      });
      yield* fs.writeFileString(settingsPath, '{ "model": "synthetic-model" }');
      assert.deepStrictEqual(yield* readClaudeHistoryRetention(homePath), {
        status: "default",
        days: 30,
        settingsPath,
      });
    }),
  );

  it.effect(
    "rereads configured rules after edits and removal without writing provider settings",
    () =>
      Effect.gen(function* () {
        const { fs, homePath, settingsPath } = yield* fixture;
        for (const days of [14, 1, 3650]) {
          const contents = `{\n // user settings\n "cleanupPeriodDays": ${days},\n}`;
          yield* fs.writeFileString(settingsPath, contents);
          assert.deepStrictEqual(yield* readClaudeHistoryRetention(homePath), {
            status: "configured",
            days,
            settingsPath,
            line: 3,
          });
          assert.strictEqual(yield* fs.readFileString(settingsPath), contents);
        }
        yield* fs.remove(settingsPath);
        assert.strictEqual((yield* readClaudeHistoryRetention(homePath)).status, "default");
      }),
  );

  it.effect(
    "locates the top-level key past comments, strings, nested objects, and duplicates",
    () =>
      Effect.gen(function* () {
        const { fs, homePath, settingsPath } = yield* fixture;
        const contents = [
          "{",
          '  // "cleanupPeriodDays": 1',
          '  /* "cleanupPeriodDays": 2 */',
          '  "note": "\\"cleanupPeriodDays\\": 3",',
          '  "cleanupPeriodDays": 5,',
          '  "env": { "cleanupPeriodDays": 4 },',
          '  "cleanupPeriodDays": 14',
          "}",
        ].join("\n");
        yield* fs.writeFileString(settingsPath, contents);
        assert.deepStrictEqual(yield* readClaudeHistoryRetention(homePath), {
          status: "configured",
          days: 14,
          settingsPath,
          line: 7,
        });
      }),
  );

  it.effect("reports the default for unreadable files and invalid rules", () =>
    Effect.gen(function* () {
      const { fs, homePath, settingsPath } = yield* fixture;
      for (const contents of [
        '{ "cleanupPeriodDays":',
        "[]",
        "null",
        ...[0, -1, 1.5, "7", null].map((cleanupPeriodDays) =>
          JSON.stringify({ cleanupPeriodDays }),
        ),
      ]) {
        yield* fs.writeFileString(settingsPath, contents);
        assert.deepStrictEqual(yield* readClaudeHistoryRetention(homePath), {
          status: "default",
          days: 30,
          settingsPath,
        });
      }
      yield* fs.remove(settingsPath);
      yield* fs.makeDirectory(settingsPath);
      assert.strictEqual((yield* readClaudeHistoryRetention(homePath)).status, "default");
    }),
  );
});
