import * as NodeNet from "node:net";
import * as Fiber from "effect/Fiber";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { fixture, nodeLayer } from "./fixtures.testkit.ts";
import { makeDeletion, DeletionLimits } from "./Deletion.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const run = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.provide(nodeLayer), Effect.scoped);

const setup = Effect.gen(function* () {
  const f = yield* fixture;
  const deletion = yield* makeDeletion.pipe(
    Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
  );
  const clean = Effect.fn("fixture.clean")(function* (patterns: readonly string[]) {
    const selected = yield* deletion.inspect(f.worktree, patterns);
    for (const target of selected) yield* deletion.remove(f.worktree, target);
    return selected.map((target) =>
      f.path.relative(f.worktree, target).split(f.path.sep).join("/"),
    );
  });
  return { ...f, deletion, clean };
});

describe("regenerable path deletion", () => {
  it.effect("keeps an ignored file while removing same-named folders with a trailing slash", () =>
    run(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.fs.writeFileString(`${f.worktree}/.gitignore`, "**/dist\ncache/\n");
        yield* f.write("dist");
        yield* f.write("web/dist/output.js");
        yield* f.write("apps/web/dist/output.js");
        yield* f.write("cache/keep.ts");
        yield* f.command(f.worktree, ["add", "-f", "cache/keep.ts"]);
        yield* f.write("cache/dist/output.js");
        expect(yield* f.clean(["cache/", "**/dist/"])).toEqual([
          "apps/web/dist",
          "cache/dist",
          "web/dist",
        ]);
        expect(yield* f.fs.exists(`${f.worktree}/cache/keep.ts`)).toBe(true);
        expect(yield* f.fs.readFileString(`${f.worktree}/dist`)).toBe("synthetic");
        expect(yield* f.clean(["dist/"])).toEqual([]);
        expect(yield* f.clean(["dist"])).toEqual(["dist"]);
      }),
    ),
  );

  it.effect(
    "deletes ignored matches, unlinks pnpm and outside links, and keeps tracked, unignored and unlisted files",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* setup;
          yield* f.write("node_modules/.pnpm/package/index.js");
          yield* f.write("packages/pkg/index.ts");
          yield* f.write(".scratch/notes.md");
          yield* f.write("dist/keep.ts");
          yield* f.command(f.worktree, ["add", "-f", "dist/keep.ts"]);
          yield* f.write("unignored/output.js");
          yield* f.linkDirectory(`${f.worktree}/packages/pkg`, `${f.worktree}/node_modules/pkg`);
          yield* f.fs.writeFileString(`${f.base}/outside.txt`, "outside");
          yield* f.linkDirectory(f.base, `${f.worktree}/node_modules/outside`);
          expect(yield* f.clean(["**/node_modules", "dist", "unignored", ".git"])).toEqual([
            "node_modules",
          ]);
          expect(yield* f.fs.exists(`${f.worktree}/node_modules`)).toBe(false);
          expect(yield* f.fs.exists(`${f.worktree}/.git`)).toBe(true);
          for (const file of [
            "packages/pkg/index.ts",
            ".scratch/notes.md",
            "dist/keep.ts",
            "unignored/output.js",
          ])
            expect(yield* f.fs.exists(`${f.worktree}/${file}`)).toBe(true);
          expect(yield* f.fs.readFileString(`${f.base}/outside.txt`)).toBe("outside");
        }),
      ),
  );

  it.effect.each([
    "selected-link",
    "parent-link",
    "nested",
    "bare",
    "unignored",
    "sparse",
    "skip-worktree",
  ] as const)("keeps %s whole", (mode) =>
    run(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.write("dist/output");
        if (mode === "selected-link") {
          yield* f.fs.rename(`${f.worktree}/dist`, `${f.base}/outside`);
          yield* f.linkDirectory(`${f.base}/outside`, `${f.worktree}/dist`);
        } else if (mode === "parent-link") {
          yield* f.fs.makeDirectory(`${f.worktree}/node_modules`);
          yield* f.linkDirectory(`${f.worktree}/dist`, `${f.worktree}/node_modules/link`);
          expect(yield* f.clean(["node_modules/link/output"])).toEqual([]);
          expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
          return;
        } else if (mode === "nested") yield* f.command(`${f.worktree}/dist`, ["init"]);
        else if (mode === "bare") yield* f.command(`${f.worktree}/dist`, ["init", "--bare"]);
        else {
          yield* f.command(f.worktree, ["add", "-f", "dist/output"]);
          if (mode === "skip-worktree")
            yield* f.command(f.worktree, ["update-index", "--skip-worktree", "dist/output"]);
          if (mode === "sparse")
            yield* f.command(f.worktree, ["config", "core.sparseCheckout", "true"]);
          if (mode === "unignored") {
            yield* f.fs.writeFileString(`${f.worktree}/.gitignore`, "dist/*\n!dist/keep\n");
            yield* f.write("dist/keep");
            yield* f.command(f.worktree, ["rm", "--cached", "-f", "dist/output"]);
          }
        }
        expect(yield* f.clean(["dist"])).toEqual([]);
        expect(
          yield* f.fs.exists(
            mode === "selected-link" ? `${f.base}/outside/output` : `${f.worktree}/dist/output`,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect.each(["mount", "device", "cap", "budget"] as const)(
    "keeps an unverifiable %s",
    (mode) =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          if (mode !== "budget") yield* f.write("dist/output");
          const deletion = yield* makeDeletion.pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
            Effect.provideService(DeletionLimits, {
              entries: mode === "cap" ? 1 : 100,
              mounts: mode === "mount" ? [`${f.worktree}/dist`] : [],
              ...(mode === "device"
                ? {
                    device: (target: string, actual: number) =>
                      target.endsWith("dist") ? actual + 1 : actual,
                  }
                : {}),
            }),
          );
          const result = yield* deletion
            .inspect(f.worktree, ["dist"], mode === "budget" ? 0 : 600_000)
            .pipe(Effect.result);
          expect(result._tag).toBe(mode === "cap" || mode === "budget" ? "Failure" : "Success");
          if (result._tag === "Success")
            for (const target of result.success) yield* deletion.remove(f.worktree, target);
          expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(mode !== "budget");
        }),
      ),
  );

  it.effect(
    "rejects truncation, clears hostile git variables, and supports info/exclude and unusual filenames",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* setup;
          yield* f.write(
            (yield* HostProcess.Platform) === "win32" ? "cache/café file" : "cache/café\nfile",
          );
          vi.stubEnv("GIT_DIR", `${f.base}/missing`);
          vi.stubEnv("GIT_WORK_TREE", f.base);
          try {
            expect(yield* f.clean(["cache"])).toEqual(["cache"]);
          } finally {
            vi.unstubAllEnvs();
          }
          yield* f.write("dist/output");
          const original = f.git;
          const deletion = yield* makeDeletion.pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, {
              ...original,
              execute: (input) =>
                original
                  .execute(input)
                  .pipe(Effect.map((result) => ({ ...result, stdoutTruncated: true }))),
            }),
          );
          expect((yield* deletion.inspect(f.worktree, ["dist"]).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect(yield* f.fs.exists(`${f.worktree}/dist/output`)).toBe(true);
          yield* f.write("private/output");
          yield* f.fs.writeFileString(`${f.root}/.git/info/exclude`, "private/\n");
          expect(yield* f.clean(["private"])).toEqual(["private"]);
          const redirected = `${f.base}/redirected`;
          yield* f.fs.makeDirectory(`${redirected}/dist`, { recursive: true });
          yield* f.fs.writeFileString(`${redirected}/.gitignore`, "dist/\n");
          yield* f.fs.writeFileString(`${f.worktree}/.gitignore`, "");
          yield* f.write("dist/precious");
          yield* f.command(f.worktree, ["config", "extensions.worktreeConfig", "true"]);
          yield* f.command(f.worktree, ["config", "--worktree", "core.worktree", redirected]);
          expect(
            (yield* f.command(f.worktree, ["rev-parse", "--show-toplevel"])).stdout.trim(),
          ).toBe(redirected.split(f.path.sep).join("/"));
          expect((yield* f.clean(["dist"]).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* f.fs.exists(`${f.worktree}/dist/precious`)).toBe(true);
        }),
      ),
  );
});

it.effect.each([".scratch", ".styal", ".scratch-with-tracked-file"])(
  "does not search unlisted ignored %s folders",
  (mode) =>
    run(
      Effect.gen(function* () {
        const f = yield* setup;
        const parent = mode === ".scratch-with-tracked-file" ? ".scratch" : mode;
        yield* f.fs.writeFileString(
          `${f.worktree}/.gitignore`,
          "**/node_modules/\n**/.turbo/\n**/*.tsbuildinfo\n.scratch/\n.styal/\n",
        );
        for (const file of [
          `${parent}/experiment/node_modules/pkg`,
          `${parent}/experiment/.turbo/cache`,
          `${parent}/experiment/build.tsbuildinfo`,
          "apps/web/node_modules/pkg",
        ])
          yield* f.write(file);
        if (mode === ".scratch-with-tracked-file") {
          yield* f.write(".scratch/keep.txt");
          yield* f.command(f.worktree, ["add", "-f", ".scratch/keep.txt"]);
          yield* f.write(".scratch/node_modules/precious");
        }
        const selected = yield* f.deletion.inspect(f.worktree, [
          "**/node_modules",
          "**/.turbo",
          "**/*.tsbuildinfo",
        ]);
        expect(selected).toEqual([f.path.join(f.worktree, "apps/web/node_modules")]);
        for (const target of selected) yield* f.deletion.remove(f.worktree, target);
        for (const file of ["node_modules/pkg", ".turbo/cache", "build.tsbuildinfo"])
          expect(yield* f.fs.exists(`${f.worktree}/${parent}/experiment/${file}`)).toBe(true);
        if (mode === ".scratch-with-tracked-file")
          expect(yield* f.fs.exists(`${f.worktree}/.scratch/node_modules/precious`)).toBe(true);
      }),
    ),
);

it.effect.each([
  ["darwin", "Build", "build"],
  ["darwin", "Café", "cafe\u0301"],
  ["win32", "Build", "build"],
] as const)("keeps %s aliases of tracked paths (%s)", ([platform, tracked, ignored]) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write(`${tracked}/keep`);
    yield* f.command(f.worktree, ["add", "-f", `${tracked}/keep`]);
    yield* f.write(`${ignored}/output`);
    yield* f.fs.writeFileString(`${f.worktree}/.gitignore`, `${ignored}/\n`);
    const deletion = yield* makeDeletion.pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
      Effect.provideService(HostProcess.Platform, platform),
    );
    for (const target of yield* deletion.inspect(f.worktree, [ignored!]))
      yield* deletion.remove(f.worktree, target);
    expect(yield* f.fs.exists(`${f.worktree}/${ignored}/output`)).toBe(true);
    expect(yield* f.fs.exists(`${f.worktree}/${tracked}/keep`)).toBe(true);
  }).pipe(Effect.provide(nodeLayer), Effect.scoped),
);

it.effect.each(["after-listing", "before-listing", "before-entry", "ancestor", "atomic"])(
  "anchors removal during a %s swap",
  (schedule) =>
    run(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.write("node_modules/dist/sentinel");
        yield* f.fs.makeDirectory(`${f.base}/outside/dist`, { recursive: true });
        yield* f.fs.writeFileString(`${f.base}/outside/sentinel`, "outside");
        yield* f.fs.writeFileString(`${f.base}/outside/dist/sentinel`, "outside");
        const preload = `${f.base}/swap.mjs`;
        const at = `${f.worktree}/node_modules/dist`;
        const swap = schedule === "ancestor" ? `${f.worktree}/node_modules` : at;
        yield* f.fs.writeFileString(
          preload,
          `
        import fs from "node:fs";
        import { spawnSync } from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const at = ${JSON.stringify(at)};
        const swap = ${JSON.stringify(swap)};
        const outside = ${JSON.stringify(`${f.base}/outside`)};
        const schedule = ${JSON.stringify(schedule)};
        const marker = ${JSON.stringify(`${f.base}/fired`)};
        const readdir = fs.readdirSync;
        const chdir = process.chdir;
        let fired = false;
        const replace = () => {
          if (fired) return;
          fired = true;
          fs.writeFileSync(marker, "fired");
          if (schedule === "atomic") {
            fs.symlinkSync(outside, swap + "-saved");
            const result = spawnSync("python3", ["-c", 'import ctypes, os, sys; libc = ctypes.CDLL(None, use_errno=True); a, b = map(os.fsencode, sys.argv[1:]); result = libc.renamex_np(a, b, 2) if sys.platform == "darwin" else libc.renameat2(-100, a, -100, b, 2); assert result == 0, ctypes.get_errno()', swap, swap + "-saved"]);
            if (result.status !== 0) throw new Error("Atomic fixture swap failed");
          } else {
            fs.renameSync(swap, swap + "-saved");
            fs.symlinkSync(outside, swap);
          }
        };
        fs.readdirSync = function(name, ...args) {
          if (process.cwd() === at && schedule === "before-listing") replace();
          const result = readdir.call(this, name, ...args);
          if (process.cwd() === at && schedule !== "before-entry") replace();
          return result;
        };
        process.chdir = function(name) {
          if (process.cwd() + "/" + name === at && schedule === "before-entry") replace();
          return chdir.call(this, name);
        };
        syncBuiltinESMExports();
      `,
        );
        expect(yield* f.deletion.inspect(f.worktree, ["node_modules"])).toEqual([
          `${f.worktree}/node_modules`,
        ]);
        const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
        const deletion = yield* makeDeletion.pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
          Effect.provideService(DeletionLimits, { entries: 100, helperPreload: preload }),
          Effect.provideService(PhysicalFileSystem.PhysicalFileSystem, {
            ...physical,
            readdir: (async (...args: Parameters<typeof physical.readdir>) => {
              const names = await physical.readdir(...args);
              if (schedule === "after-listing" && args[0] === at) {
                await physical.writeFile(`${f.base}/fired`, "fired");
                await physical.rename(at, `${at}-saved`);
                await physical.symlink(`${f.base}/outside`, at);
              }
              return names;
            }) as typeof physical.readdir,
          }),
        );
        const result = yield* deletion
          .remove(f.worktree, `${f.worktree}/node_modules`)
          .pipe(Effect.result);
        expect(yield* f.fs.readFileString(`${f.base}/fired`)).toBe("fired");
        expect(yield* f.fs.readFileString(`${f.base}/outside/sentinel`)).toBe("outside");
        expect(yield* f.fs.readFileString(`${f.base}/outside/dist/sentinel`)).toBe("outside");
        const saved = schedule === "ancestor" ? `${swap}-saved/dist` : `${swap}-saved`;
        expect(yield* f.fs.exists(`${saved}/sentinel`)).toBe(schedule === "before-entry");
        expect(result._tag).toBe("Failure");
      }),
    ),
);

it.effect("counts allocated bytes only for single-link files in the worker", () =>
  run(
    Effect.gen(function* () {
      const f = yield* setup;
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      yield* f.write("dist/allocated", "x".repeat(8192));
      yield* f.fs.writeFileString(`${f.base}/shared`, "keep");
      yield* Effect.promise(() => physical.link(`${f.base}/shared`, `${f.worktree}/dist/shared`));
      const stat = yield* Effect.promise(() => physical.lstat(`${f.worktree}/dist/allocated`));
      expect(yield* f.deletion.remove(f.worktree, `${f.worktree}/dist`)).toBe(stat.blocks * 512);
      expect(yield* f.fs.readFileString(`${f.base}/shared`)).toBe("keep");
      expect(yield* f.fs.exists(`${f.worktree}/dist`)).toBe(false);
    }),
  ),
);

it.effect.each(["mount", "cap", "budget", "repository"])("worker refuses %s", (mode) =>
  run(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.write("dist/sentinel");
      if (mode === "repository") yield* f.command(`${f.worktree}/dist`, ["init"]);
      const deletion = yield* makeDeletion.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
        Effect.provideService(DeletionLimits, {
          entries: mode === "cap" ? 1 : 100,
          mounts: mode === "mount" ? [`${f.worktree}/dist`] : [],
        }),
      );
      const result = yield* deletion
        .remove(f.worktree, `${f.worktree}/dist`, mode === "budget" ? 0 : 600_000)
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* f.fs.readFileString(`${f.worktree}/dist/sentinel`)).toBe("synthetic");
    }),
  ),
);

it.live("stops the isolated worker when removal is interrupted", () =>
  run(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.write("dist/sentinel");
      const connected = Promise.withResolvers<NodeNet.Socket>();
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => NodeNet.createServer(connected.resolve)),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      const address = server.address() as NodeNet.AddressInfo;
      const preload = `${f.base}/hold.mjs`;
      yield* f.fs.writeFileString(
        preload,
        `
        import net from "node:net";
        const socket = net.connect(${address.port}, "127.0.0.1");
        await new Promise(() => {});
      `,
      );
      const deletion = yield* makeDeletion.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
        Effect.provideService(DeletionLimits, { entries: 100, helperPreload: preload }),
      );
      const removal = yield* deletion
        .remove(f.worktree, `${f.worktree}/dist`)
        .pipe(Effect.forkChild);
      const socket = yield* Effect.promise(() => connected.promise);
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      yield* Fiber.interrupt(removal);
      yield* Effect.promise(() => closed);
      expect(yield* f.fs.readFileString(`${f.worktree}/dist/sentinel`)).toBe("synthetic");
    }),
  ),
);

it.effect.each([
  "staged",
  "staged-descendant",
  "unignored",
  "unignored-empty",
  "incomplete",
  "git-error",
  "expired",
])("keeps a match when Git protection becomes %s after inspection", (mode) =>
  run(
    Effect.gen(function* () {
      const f = yield* setup;
      const file = mode === "staged-descendant" ? "dist/deep/keep" : "dist/keep";
      yield* f.write(file);
      const selected = yield* f.deletion.inspect(f.worktree, ["dist"]);
      expect(selected).toEqual([`${f.worktree}/dist`]);
      if (mode.startsWith("staged")) yield* f.command(f.worktree, ["add", "-f", file]);
      if (mode.startsWith("unignored")) yield* f.fs.writeFileString(`${f.worktree}/.gitignore`, "");
      if (mode === "unignored-empty") {
        yield* f.fs.remove(`${f.worktree}/${file}`);
        yield* f.fs.makeDirectory(`${f.worktree}/dist/empty`);
      }
      let commands = 0;
      const deletion = yield* makeDeletion.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, {
          ...f.git,
          execute: (input) => {
            commands++;
            return f.git.execute(input).pipe(
              Effect.map((result) => ({
                ...result,
                stdoutTruncated: mode === "incomplete" || result.stdoutTruncated,
                exitCode: mode === "git-error" ? 128 : result.exitCode,
              })),
            );
          },
        }),
      );
      const result = yield* deletion
        .remove(f.worktree, selected[0]!, mode === "expired" ? 0 : 600_000)
        .pipe(Effect.result);
      if (mode === "expired") expect(commands).toBe(0);
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WorktreeCleanupError" } });
      if (mode === "unignored-empty")
        expect(yield* f.fs.exists(`${f.worktree}/dist/empty`)).toBe(true);
      else expect(yield* f.fs.readFileString(`${f.worktree}/${file}`)).toBe("synthetic");
    }),
  ),
);
