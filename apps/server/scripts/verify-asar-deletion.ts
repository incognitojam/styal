// @effect-diagnostics nodeBuiltinImport:off -- This integration check runs directly in Electron's Node mode.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeTest from "node:test";
import { makeTempDirectoryScoped, removeDirectory } from "@t3tools/shared/removeDirectory";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { fixture, nodeLayer } from "../src/worktreeCleanup/fixtures.testkit.ts";
import { makeDeletion } from "../src/worktreeCleanup/Deletion.ts";
import { removeLinkedWorktree } from "../src/vcs/worktreeRemoval.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";

NodeAssert.ok(
  process.versions.electron,
  "Run this check with ELECTRON_RUN_AS_NODE=1 and Electron.",
);
const physical = NodeModule.createRequire(import.meta.url)("original-fs") as typeof NodeFS;

function archive() {
  const contents = Buffer.from("module.exports = 'synthetic';\n");
  const json = Buffer.from(
    JSON.stringify({ files: { "late.cjs": { size: contents.length, offset: "0" } } }),
  );
  const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
  header.writeUInt32LE(header.length - 4, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, contents]);
}

const withFixture = <E>(
  body: (
    f: Effect.Success<typeof fixture>,
  ) => Effect.Effect<void, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        // Remove synthetic archives before the fixture's archive-aware finalizer runs.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => physical.rmSync(f.base, { recursive: true, force: true })),
        );
        const directory = `${f.worktree}/node_modules/electron/dist/resources`;
        physical.mkdirSync(directory, { recursive: true });
        physical.writeFileSync(`${directory}/x.asar`, archive());
        yield* body(f);
      }),
    ).pipe(Effect.provide(nodeLayer)),
  );

for (const platform of ["darwin", "win32"] as const) {
  await NodeTest.test(`worktree removal deletes nested archives (${platform} path)`, () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* removeLinkedWorktree({
          operation: "verify-asar",
          cwd: f.root,
          worktreePath: f.worktree,
          force: true,
          execute: f.git.execute,
          run: (args) => f.command(f.root, args),
        }).pipe(Effect.provideService(HostProcess.Platform, platform));
        NodeAssert.equal(physical.existsSync(f.worktree), false);
      }),
    ),
  );
}

await NodeTest.test("regenerable cleanup selects and deletes a tree containing an archive", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const deletion = yield* makeDeletion.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
      );
      const selected = yield* deletion.inspect(f.worktree, ["node_modules"]);
      NodeAssert.deepEqual(selected, [`${f.worktree}/node_modules`]);
      yield* deletion.remove(f.worktree, selected[0]!);
      NodeAssert.equal(physical.existsSync(`${f.worktree}/node_modules`), false);
      const serverArchive = `${f.base}/server.asar`;
      physical.writeFileSync(serverArchive, archive());
      NodeAssert.equal(
        NodeModule.createRequire(import.meta.url)(`${serverArchive}/late.cjs`),
        "synthetic",
      );
      NodeAssert.notEqual((process as NodeJS.Process & { noAsar?: boolean }).noAsar, true);
    }),
  ),
);

await NodeTest.test(
  "directory cleanup preserves outside links, force semantics, and scoped cleanup",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const outside = `${f.base}/outside`;
        physical.mkdirSync(outside);
        physical.writeFileSync(`${outside}/keep`, "synthetic");
        physical.symlinkSync(outside, `${f.worktree}/node_modules/outside`, "junction");
        yield* removeDirectory(f.fs, `${f.worktree}/node_modules`);
        NodeAssert.equal(physical.existsSync(`${f.worktree}/node_modules`), false);
        NodeAssert.equal(physical.readFileSync(`${outside}/keep`, "utf8"), "synthetic");
        const missing = yield* Effect.result(removeDirectory(f.fs, `${f.base}/missing`));
        NodeAssert.equal(missing._tag, "Failure");
        if (missing._tag === "Failure") NodeAssert.equal(missing.failure.reason._tag, "NotFound");
        yield* removeDirectory(f.fs, `${f.base}/missing`, { force: true });
        const temporary = yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* makeTempDirectoryScoped(f.fs, { directory: f.base });
            physical.writeFileSync(`${directory}/x.asar`, archive());
            return directory;
          }),
        );
        NodeAssert.equal(physical.existsSync(temporary), false);
      }),
    ),
);
