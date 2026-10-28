import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import { copyFileBytes, copyFileBytesPromise } from "./fileCopy.ts";

// Larger than one read chunk, so the copy must stream several chunks in order.
const contents = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, index) => index % 251);

describe("copyFileBytes", () => {
  it.effect("copies every byte and replaces an existing target", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const source = `${directory}/source`;
      const target = `${directory}/target`;
      yield* fileSystem.writeFile(source, contents);
      yield* fileSystem.writeFileString(target, "previous contents that are longer than nothing");

      yield* copyFileBytes(fileSystem, source, target);

      assert.isTrue(Buffer.from(contents).equals(yield* fileSystem.readFile(target)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an existing target when copying exclusively", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const source = `${directory}/source`;
      const target = `${directory}/target`;
      yield* fileSystem.writeFile(source, contents);
      yield* fileSystem.writeFileString(target, "kept");

      const exit = yield* copyFileBytes(fileSystem, source, target, { flag: "wx" }).pipe(
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* fileSystem.readFileString(target), "kept");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("gives a new target the source's permission bits", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const source = `${directory}/source`;
      yield* fileSystem.writeFileString(source, "private");
      yield* fileSystem.chmod(source, 0o600);

      yield* copyFileBytes(fileSystem, source, `${directory}/effect-target`);
      yield* Effect.promise(() => copyFileBytesPromise(source, `${directory}/promise-target`));

      for (const target of ["effect-target", "promise-target"]) {
        const info = yield* fileSystem.stat(`${directory}/${target}`);
        assert.strictEqual(info.mode & 0o777, 0o600);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("copyFileBytesPromise", () => {
  it.effect("copies every byte, and keeps an existing target when copying exclusively", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const source = `${directory}/source`;
      const target = `${directory}/target`;
      const kept = `${directory}/kept`;
      yield* fileSystem.writeFile(source, contents);
      yield* fileSystem.writeFileString(kept, "kept");

      yield* Effect.promise(() => copyFileBytesPromise(source, target, { flags: "wx" }));
      const exclusive = yield* Effect.tryPromise(() =>
        copyFileBytesPromise(source, kept, { flags: "wx" }),
      ).pipe(Effect.exit);

      assert.isTrue(Buffer.from(contents).equals(yield* fileSystem.readFile(target)));
      assert.isTrue(Exit.isFailure(exclusive));
      assert.strictEqual(yield* fileSystem.readFileString(kept), "kept");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
