import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { physicalFileSystem } from "./physicalFileSystem.ts";

const reasons: Readonly<Record<string, PlatformError.SystemErrorTag>> = {
  ENOENT: "NotFound",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EISDIR: "BadResource",
  ENOTDIR: "BadResource",
  EBUSY: "Busy",
  ELOOP: "BadResource",
};

export const removeDirectory = Effect.fn("FileSystem.removeDirectory")(function* (
  fileSystem: FileSystem.FileSystem,
  target: string,
  options?: { readonly force?: boolean },
) {
  if (!process.versions.electron)
    return yield* fileSystem.remove(target, { recursive: true, ...options });
  return yield* Effect.tryPromise({
    try: () =>
      physicalFileSystem.promises.rm(target, { recursive: true, force: options?.force ?? false }),
    catch: (cause) => {
      const error = cause as NodeJS.ErrnoException;
      return PlatformError.systemError({
        _tag: reasons[error.code ?? ""] ?? "Unknown",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: target,
        syscall: error.syscall,
        cause,
      });
    },
  });
});

export const makeTempDirectoryScoped = (
  fileSystem: FileSystem.FileSystem,
  options?: Parameters<FileSystem.FileSystem["makeTempDirectory"]>[0],
) =>
  process.versions.electron
    ? Effect.acquireRelease(fileSystem.makeTempDirectory(options), (directory) =>
        removeDirectory(fileSystem, directory, { force: true }).pipe(Effect.orDie),
      )
    : fileSystem.makeTempDirectoryScoped(options);
