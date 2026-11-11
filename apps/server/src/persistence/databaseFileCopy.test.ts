// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFSP from "node:fs/promises";
import { cloneDatabaseFile } from "./databaseFileCopy.ts";

it.effect("clones a public source into private staging", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "pruning-mode-" });
    yield* fs.writeFileString(`${root}/source`, "synthetic history");
    yield* Effect.promise(() => NodeFSP.chmod(`${root}/source`, 0o644));
    const cloned = yield* Effect.promise(() =>
      cloneDatabaseFile(`${root}/source`, `${root}/staging`),
    );
    if (!cloned) {
      return;
    }
    assert.equal(
      (yield* Effect.promise(() => NodeFSP.stat(`${root}/staging`))).mode & 0o777,
      0o600,
    );
    assert.equal(yield* fs.readFileString(`${root}/staging`), "synthetic history");
  }).pipe(Effect.provide(NodeServices.layer)),
);
