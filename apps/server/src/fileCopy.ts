// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeStreamPromises from "node:stream/promises";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

const permissionBits = (mode: number) => mode & 0o7777;

/**
 * Streams bytes instead of `fs.copyFile`: on OpenZFS 2.2+ with `zfs_bclone_wait_dirty`, its
 * `copy_file_range` block clone of a recently written file waits for the next transaction group
 * sync, which can take minutes. A new target gets the source's permission bits, as with `copyFile`.
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
