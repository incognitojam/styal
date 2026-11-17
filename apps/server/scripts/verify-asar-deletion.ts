// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off -- Standalone Electron check embeds synthetic subprocess inputs.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { deviceToolMaintenanceScript } from "../src/device/deviceToolMaintenance.ts";
import { simslimHostScript } from "../src/device/simslimHostScript.ts";
import * as NodeModule from "node:module";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import type * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { fixture, nodeLayer } from "../src/worktreeCleanup/fixtures.testkit.ts";
import { makeDeletion } from "../src/worktreeCleanup/Deletion.ts";
import { removeLinkedWorktree } from "../src/vcs/worktreeRemoval.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";

NodeAssert.ok(
  process.versions.electron,
  "Run this check with ELECTRON_RUN_AS_NODE=1 and Electron.",
);
const physical = NodeModule.createRequire(import.meta.url)("original-fs") as typeof NodeFS;
const expected = HostProcess.Platform.defaultValue() === "win32" ? 6 : 8;
let completed = 0;
let passed = 0;
let failed = 0;
let finished = false;
const output = (message: string) => NodeFS.writeSync(1, `${message}\n`);
process.exitCode = 1;
process.once("beforeExit", () => {
  const complete = finished && completed === expected;
  process.exitCode = complete && failed === 0 ? 0 : 1;
  output(
    `ASAR_DELETION_SUMMARY expected=${expected} completed=${completed} passed=${passed} failed=${failed} status=${complete ? "complete" : "incomplete"}`,
  );
});

async function scenario(name: string, body: () => Promise<void>) {
  output(`START ${name}`);
  try {
    await body();
    if (HostProcess.Platform.defaultValue() === "win32" && name.includes("darwin path"))
      NodeAssert.fail("Intentional Windows gate verification failure");
    passed += 1;
    output(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    output(`FAIL ${name}\n${NodeUtil.inspect(error, { depth: 12, colors: false })}`);
  } finally {
    completed += 1;
  }
}

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
  ) => Effect.Effect<
    void,
    E,
    FileSystem.FileSystem | Path.Path | PhysicalFileSystem.PhysicalFileSystem
  >,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const directory = `${f.worktree}/node_modules/electron/dist/resources`;
        physical.mkdirSync(directory, { recursive: true });
        physical.writeFileSync(`${directory}/x.asar`, archive());
        yield* body(f);
      }),
    ).pipe(Effect.provide(nodeLayer)),
  );

for (const platform of ["darwin", "win32"] as const) {
  await scenario(`worktree removal deletes nested archives (${platform} path)`, () =>
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

// Regenerable-file cleanup is disabled on Windows.
if (HostProcess.Platform.defaultValue() !== "win32")
  await scenario("regenerable cleanup selects and deletes a tree containing an archive", () =>
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

await scenario(
  "directory cleanup preserves outside links, force semantics, and scoped cleanup",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const outside = `${f.base}/outside`;
        physical.mkdirSync(outside);
        physical.writeFileSync(`${outside}/keep`, "synthetic");
        physical.symlinkSync(outside, `${f.worktree}/node_modules/outside`, "junction");
        yield* f.fs.remove(`${f.worktree}/node_modules`, { recursive: true });
        NodeAssert.equal(physical.existsSync(`${f.worktree}/node_modules`), false);
        NodeAssert.equal(physical.readFileSync(`${outside}/keep`, "utf8"), "synthetic");
        const missing = yield* Effect.result(f.fs.remove(`${f.base}/missing`, { recursive: true }));
        NodeAssert.equal(missing._tag, "Failure");
        if (missing._tag === "Failure") NodeAssert.equal(missing.failure.reason._tag, "NotFound");
        yield* f.fs.remove(`${f.base}/missing`, { recursive: true, force: true });
        const temporary = yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* f.fs.makeTempDirectoryScoped({ directory: f.base });
            physical.writeFileSync(`${directory}/x.asar`, archive());
            return directory;
          }),
        );
        NodeAssert.equal(physical.existsSync(temporary), false);
        const temporaryFile = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* f.fs.makeTempFileScoped({ directory: f.base });
            physical.writeFileSync(`${file}.asar`, archive());
            return file;
          }),
        );
        NodeAssert.equal(physical.existsSync(NodePath.dirname(temporaryFile)), false);
      }),
    ),
);

await scenario("an injected filesystem can refuse recursive deletion", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      let called = false;
      const guarded = {
        ...f.fs,
        remove: () => {
          called = true;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "remove",
            }),
          );
        },
      };
      const result = yield* Effect.result(
        removeLinkedWorktree({
          operation: "verify-guard",
          cwd: f.root,
          worktreePath: f.worktree,
          force: true,
          execute: f.git.execute,
          run: (args) => f.command(f.root, args),
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(FileSystem.FileSystem, guarded),
        ),
      );
      NodeAssert.equal(called, true);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(physical.existsSync(`${f.worktree}/node_modules`), true);
    }),
  ),
);

await scenario("the physical deletion backend can be replaced by a refusing service", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      let called = false;
      const guarded = {
        ...physical,
        rm: () => {
          called = true;
          return Promise.reject(Object.assign(new Error("Synthetic refusal"), { code: "EPERM" }));
        },
      };
      const result = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* Effect.result(fs.remove(`${f.worktree}/node_modules`, { recursive: true }));
      }).pipe(
        Effect.provide(PhysicalFileSystem.layerFileSystem, { local: true }),
        Effect.provideService(PhysicalFileSystem.PhysicalFileSystem, guarded),
      );
      NodeAssert.equal(called, true);
      NodeAssert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        NodeAssert.equal(result.failure.reason._tag, "PermissionDenied");
      NodeAssert.equal(NodeFS.existsSync(`${f.worktree}/node_modules`), true);
    }),
  ),
);

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

await scenario("device tool pruning removes obsolete installs containing ASARs", () =>
  withFixture((f) =>
    Effect.promise(async () => {
      const root = `${f.base}/tools`;
      for (const [index, version] of ["0.1.0", "0.2.0", "0.3.0"].entries()) {
        const directory = `${root}/synthetic/${version}`;
        physical.mkdirSync(directory, { recursive: true });
        physical.writeFileSync(`${directory}/x.asar`, archive());
        physical.writeFileSync(`${directory}/.install-complete`, version);
        physical.utimesSync(`${directory}/.install-complete`, index + 1, index + 1);
      }
      await exec(process.execPath, [
        "-e",
        deviceToolMaintenanceScript +
          `
      pruneTools(${JSON.stringify(root)}, [['synthetic', '0.3.0']], false).catch(error => { console.error(error); process.exitCode = 1; });
    `,
      ]);
      NodeAssert.equal(physical.existsSync(`${root}/synthetic/0.1.0`), false);
      NodeAssert.equal(physical.existsSync(`${root}/synthetic/0.2.0/x.asar`), true);
      NodeAssert.equal(physical.existsSync(`${root}/synthetic/0.3.0/x.asar`), true);
    }),
  ),
);

// simslim only runs on macOS; substitute a rejected download to exercise its finally path.
if (HostProcess.Platform.defaultValue() !== "win32")
  await scenario("simslim clears ASAR-containing staging when a download is rejected", () =>
    withFixture((f) =>
      Effect.promise(async () => {
        const prelude = `
      import * as testModule from 'node:module';
      const testRequire = testModule.createRequire(import.meta.url);
      const testFs = testRequire('original-fs');
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      process.argv.push('install');
      testRequire('node:os').homedir = () => ${JSON.stringify(f.base)};
      globalThis.fetch = async () => {
        const parent = ${JSON.stringify(NodePath.join(f.base, ".cache", "styal", "simslim"))};
        const root = parent + '/' + testFs.readdirSync(parent)[0];
        const staging = root + '/' + testFs.readdirSync(root).find(name => name.startsWith('.install-'));
        testFs.writeFileSync(staging + '/x.asar', Buffer.from(${JSON.stringify(archive().toString("base64"))}, 'base64'));
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
      };
      testModule.syncBuiltinESMExports();
    `;
        await NodeAssert.rejects(
          exec(process.execPath, ["--input-type=module", "--eval", prelude + simslimHostScript]),
          {
            stderr: /Error: SimSlim checksum mismatch/,
          },
        );
        const parent = NodePath.join(f.base, ".cache", "styal", "simslim");
        const version = physical.readdirSync(parent)[0]!;
        NodeAssert.deepEqual(physical.readdirSync(NodePath.join(parent, version)), []);
      }),
    ),
  );

finished = true;
