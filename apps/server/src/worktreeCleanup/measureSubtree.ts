// @effect-diagnostics nodeBuiltinImport:off - FileSystem.stat follows links; native lstat avoids a failed readLink per file.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const makeMeasureSubtree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  // The enclosing storageCleanup.measureWorktree span covers batched native lstat probes.
  return Effect.fnUntraced(
    function* (root: string, targetPath: string, skipped: string | null) {
      const start = path.resolve(targetPath);
      if (start !== root && !inside(root, start)) return null;
      if (skipped !== null && (start === skipped || inside(skipped, start))) return 0;
      const pending = [start];
      let entries = 1;
      let bytes = 0;
      // lstat avoids following links without a failing readLink syscall for every regular file.
      const inspect = Effect.fnUntraced(function* (target: string) {
        if (target === skipped) return true;
        const stat = yield* Effect.tryPromise(() => NodeFSP.lstat(target));
        if (stat.isSymbolicLink()) return true;
        if ((yield* fs.realPath(target)) !== target) return false;
        if (stat.isFile()) {
          if (stat.nlink === 1)
            bytes += typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
        } else if (stat.isDirectory()) {
          const names = yield* fs.readDirectory(target);
          entries += names.length;
          if (entries > 2_000_000) return false;
          for (const name of names) {
            const child = path.join(target, name);
            if (!inside(root, child)) return false;
            pending.push(child);
          }
        }
        return true;
      });
      while (pending.length > 0) {
        const results = yield* Effect.forEach(pending.splice(-64), inspect, { concurrency: 64 });
        if (results.some((complete) => !complete)) return null;
        yield* Effect.yieldNow;
      }
      return bytes;
    },
    Effect.orElseSucceed(() => null),
  );
});
