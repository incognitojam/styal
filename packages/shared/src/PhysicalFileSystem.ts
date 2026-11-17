// @effect-diagnostics nodeBuiltinImport:off -- Implements physical Node deletion and scoped temp-path cleanup.
import * as NodePath from "node:path";
import type * as NodeFSP from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { getPhysicalFileSystem } from "./physicalFileSystemNode.ts";

export class PhysicalFileSystem extends Context.Service<PhysicalFileSystem, typeof NodeFSP>()(
  "@t3tools/shared/PhysicalFileSystem",
) {}

export const layer = Layer.sync(PhysicalFileSystem, () => getPhysicalFileSystem().promises);

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

export const layerFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!process.versions.electron) return fileSystem;
    const physical = yield* PhysicalFileSystem;
    const remove: FileSystem.FileSystem["remove"] = Effect.fn("PhysicalFileSystem.remove")(
      function* (target, options) {
        yield* Effect.tryPromise({
          try: () =>
            physical.rm(target, {
              recursive: options?.recursive ?? false,
              force: options?.force ?? false,
            }),
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
      },
    );
    const makeTempDirectoryScoped: FileSystem.FileSystem["makeTempDirectoryScoped"] = Effect.fn(
      "PhysicalFileSystem.makeTempDirectoryScoped",
    )((options) =>
      Effect.acquireRelease(fileSystem.makeTempDirectory(options), (directory) =>
        remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      ),
    );
    const makeTempFileScoped: FileSystem.FileSystem["makeTempFileScoped"] = Effect.fn(
      "PhysicalFileSystem.makeTempFileScoped",
    )((options) =>
      Effect.acquireRelease(fileSystem.makeTempFile(options), (file) =>
        remove(NodePath.dirname(file), { recursive: true, force: true }).pipe(Effect.orDie),
      ),
    );
    return FileSystem.FileSystem.of({
      ...fileSystem,
      remove,
      makeTempDirectoryScoped,
      makeTempFileScoped,
    });
  }),
);
