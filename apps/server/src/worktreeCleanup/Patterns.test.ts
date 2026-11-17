import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { fixture, nodeLayer } from "./fixtures.testkit.ts";
import { makeReadPatterns } from "./PatternSource.ts";

it.effect.each(["withdrawn", "subfolder", "remote-without-head", "non-origin-remote"] as const)(
  "reads cleanup patterns for %s",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(`${f.root}/styal.json`, '{"worktreeCleanup":["dist"]}');
      yield* f.fs.makeDirectory(`${f.root}/apps/web`, { recursive: true });
      yield* f.fs.writeFileString(
        `${f.root}/apps/web/styal.json`,
        '{"worktreeCleanup":["node_modules"]}',
      );
      yield* f.command(f.root, ["add", "."]);
      yield* f.command(f.root, ["commit", "-m", "fixture: cleanup declarations"]);
      const origin = `${f.base}/origin.git`;
      yield* f.command(f.base, ["init", "--bare", "-b", "main", origin]);
      yield* f.command(f.root, [
        "remote",
        "add",
        mode === "non-origin-remote" ? "upstream" : "origin",
        origin,
      ]);
      yield* f.command(f.root, [
        "push",
        mode === "non-origin-remote" ? "upstream" : "origin",
        "main",
      ]);
      if (mode === "withdrawn" || mode === "subfolder")
        yield* f.command(f.root, ["remote", "set-head", "origin", "main"]);
      if (mode === "withdrawn") {
        yield* f.command(f.root, ["checkout", "-b", "publish"]);
        yield* f.fs.writeFileString(`${f.root}/styal.json`, '{"worktreeCleanup":[]}');
        yield* f.command(f.root, ["add", "styal.json"]);
        yield* f.command(f.root, ["commit", "-m", "fixture: withdraw remote pattern"]);
        yield* f.command(f.root, ["push", "origin", "HEAD:main"]);
        yield* f.command(f.root, ["checkout", "main"]);
      }
      const read = yield* makeReadPatterns.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
      );
      expect(yield* read(mode === "subfolder" ? `${f.root}/apps/web` : f.root)).toEqual(
        mode === "subfolder" ? ["node_modules"] : [],
      );
    }).pipe(Effect.provide(nodeLayer), Effect.scoped),
);
