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
    return selected.map((target) => target.slice(f.worktree.length + 1));
  });
  return { ...f, deletion, clean };
});

describe("regenerable path deletion", () => {
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
          yield* f.fs.symlink(`${f.worktree}/packages/pkg`, `${f.worktree}/node_modules/pkg`);
          yield* f.fs.writeFileString(`${f.base}/outside.txt`, "outside");
          yield* f.fs.symlink(f.base, `${f.worktree}/node_modules/outside`);
          expect(yield* f.clean(["**/node_modules", "dist", "unignored"])).toEqual([
            "node_modules",
          ]);
          expect(yield* f.fs.exists(`${f.worktree}/node_modules`)).toBe(false);
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
          yield* f.fs.symlink(`${f.base}/outside`, `${f.worktree}/dist`);
        } else if (mode === "parent-link") {
          yield* f.fs.makeDirectory(`${f.worktree}/node_modules`);
          yield* f.fs.symlink(`${f.worktree}/dist`, `${f.worktree}/node_modules/link`);
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
          yield* f.write("cache/café\nfile");
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
          ).toBe(redirected);
          expect((yield* f.clean(["dist"]).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* f.fs.exists(`${f.worktree}/dist/precious`)).toBe(true);
        }),
      ),
  );
});

it.effect.each([".scratch", ".styal"])("does not search unlisted ignored %s folders", (parent) =>
  run(
    Effect.gen(function* () {
      const f = yield* setup;
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
      const selected = yield* f.deletion.inspect(f.worktree, [
        "**/node_modules",
        "**/.turbo",
        "**/*.tsbuildinfo",
      ]);
      expect(selected).toEqual([`${f.worktree}/apps/web/node_modules`]);
      for (const target of selected) yield* f.deletion.remove(f.worktree, target);
      for (const file of ["node_modules/pkg", ".turbo/cache", "build.tsbuildinfo"])
        expect(yield* f.fs.exists(`${f.worktree}/${parent}/experiment/${file}`)).toBe(true);
    }),
  ),
);

it.effect.each([
  ["Build", "build"],
  ["Café", "cafe\u0301"],
])("keeps macOS case and Unicode aliases of tracked paths (%s)", ([tracked, ignored]) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write(`${tracked}/keep`);
    yield* f.command(f.worktree, ["add", "-f", `${tracked}/keep`]);
    yield* f.write(`${ignored}/output`);
    yield* f.fs.writeFileString(`${f.worktree}/.gitignore`, `${ignored}/\n`);
    const deletion = yield* makeDeletion.pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
      Effect.provideService(HostProcess.Platform, "darwin"),
    );
    for (const target of yield* deletion.inspect(f.worktree, [ignored!]))
      yield* deletion.remove(f.worktree, target);
    expect(yield* f.fs.exists(`${f.worktree}/${ignored}/output`)).toBe(true);
    expect(yield* f.fs.exists(`${f.worktree}/${tracked}/keep`)).toBe(true);
  }).pipe(Effect.provide(nodeLayer), Effect.scoped),
);
