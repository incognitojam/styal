// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeStreamPromises from "node:stream/promises";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

const permissionBits = (mode: number) => mode & 0o7777;

/**
 * Copies a file by streaming its bytes instead of calling `fs.copyFile`.
 *
 * On Linux `fs.copyFile` uses `copy_file_range`, which OpenZFS 2.2+ turns into a block clone.
 * With `zfs_bclone_wait_dirty` set, cloning a file written since the last transaction group sync
 * waits for that sync, which can take seconds to minutes on a busy pool. Node's clone flags take
 * the same path, so no `copyFile` mode avoids it.
 *
 * A new target gets the source's permission bits, as with `copyFile`, so a private file stays private.
 */
export const copyFileBytes = (
  fileSystem: FileSystem.FileSystem,
  fromPath: string,
  toPath: string,
  options?: { readonly flag?: FileSystem.OpenFlag },
) =>
  fileSystem
    .stat(fromPath)
    .pipe(
      Effect.flatMap((info) =>
        fileSystem
          .stream(fromPath)
          .pipe(
            Stream.run(
              fileSystem.sink(toPath, { flag: options?.flag, mode: permissionBits(info.mode) }),
            ),
          ),
      ),
    );

/** {@link copyFileBytes} for code without an Effect runtime. */
export const copyFileBytesPromise = async (
  fromPath: string,
  toPath: string,
  options?: { readonly flags?: string },
) => {
  const { mode } = await NodeFS.promises.stat(fromPath);
  await NodeStreamPromises.pipeline(
    NodeFS.createReadStream(fromPath),
    NodeFS.createWriteStream(toPath, { flags: options?.flags ?? "w", mode: permissionBits(mode) }),
  );
};
