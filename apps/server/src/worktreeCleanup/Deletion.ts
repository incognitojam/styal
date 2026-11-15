// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem has neither lstat nor non-recursive rmdir.
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Path from "effect/Path";
import { WorktreeCleanupError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { matchesWorktreeCleanupPattern } from "@t3tools/shared/worktreeCleanupPatterns";
import { makeInspectGit } from "./gitInspection.ts";

export class DeletionLimits extends Context.Reference<{
  readonly entries: number;
  readonly mounts?: readonly string[];
  readonly now?: () => number;
  readonly device?: (target: string, actual: number) => number;
}>("worktreeCleanup/DeletionLimits", { defaultValue: () => ({ entries: 1_000_000 }) }) {}

const inside = (root: string, target: string) => target.startsWith(`${root}/`);

export const makeDeletion = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const now = () => limits.now?.() ?? clock.currentTimeMillisUnsafe();
  const platform = yield* HostProcess.Platform;
  const canonical = (value: string) =>
    platform === "darwin" ? value.normalize("NFD").toLowerCase() : value;
  const path = yield* Path.Path;
  const git = yield* makeInspectGit;
  const limits = yield* DeletionLimits;
  const inspect = Effect.fn("WorktreeCleanup.inspect")(function* (
    root: string,
    patterns: readonly string[],
    budgetMs = 600_000,
  ) {
    const deadline = now() + budgetMs;
    if (now() >= deadline)
      return yield* new WorktreeCleanupError({
        reason: "run-failed",
        message: "Cleanup inspection exceeded its budget.",
      });
    const top = yield* git(root, ["rev-parse", "--show-toplevel"]);
    const correctRoot =
      top.exitCode === 0 &&
      !top.stdoutTruncated &&
      (yield* Effect.tryPromise(
        async () =>
          (await NodeFSP.realpath(top.stdout.replace(/\r?\n$/, ""))) ===
          (await NodeFSP.realpath(root)),
      ));
    if (!correctRoot || now() >= deadline)
      return yield* new WorktreeCleanupError({
        reason: "run-failed",
        message: "Cleanup inspection is incomplete or Git targets another worktree.",
      });
    const ignored = yield* git(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    if (
      ignored.exitCode !== 0 ||
      ignored.stdoutTruncated ||
      (ignored.stdout && !ignored.stdout.endsWith("\0"))
    )
      return yield* new WorktreeCleanupError({
        reason: "run-failed",
        message: "Incomplete ignored list.",
      });
    if (now() >= deadline)
      return yield* new WorktreeCleanupError({
        reason: "run-failed",
        message: "Cleanup inspection exceeded its budget.",
      });
    if (!ignored.stdout) return [];
    const protectedOutput = yield* git(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (
      protectedOutput.exitCode !== 0 ||
      protectedOutput.stdoutTruncated ||
      (protectedOutput.stdout && !protectedOutput.stdout.endsWith("\0"))
    )
      return yield* new WorktreeCleanupError({
        reason: "run-failed",
        message: "Incomplete protected list.",
      });
    const protectedPaths = protectedOutput.stdout.split("\0").filter(Boolean).map(canonical);
    const ignoredPaths = ignored.stdout.split("\0").filter(Boolean);
    const ancestors = [
      ...new Set(
        ignoredPaths.flatMap((entry) => {
          const parts = entry.replace(/\/$/, "").split("/");
          return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
        }),
      ),
    ];
    const blockedAncestors = new Set<string>();
    if (ancestors.length) {
      const parents = yield* git(
        root,
        ["check-ignore", "--no-index", "-z", "--stdin"],
        `${ancestors.join("\0")}\0`,
      );
      if (
        (parents.exitCode !== 0 && parents.exitCode !== 1) ||
        parents.stdoutTruncated ||
        (parents.stdout && !parents.stdout.endsWith("\0"))
      )
        return yield* new WorktreeCleanupError({
          reason: "run-failed",
          message: "Incomplete ignored ancestor list.",
        });
      for (const parent of parents.stdout.split("\0").filter(Boolean))
        if (!patterns.some((pattern) => matchesWorktreeCleanupPattern(pattern, parent)))
          blockedAncestors.add(parent);
    }
    return yield* Effect.tryPromise(async () => {
      const rootStat = await NodeFSP.lstat(root);
      if (
        !(await NodeFSP.lstat(path.join(root, ".git"))).isFile() ||
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        (await NodeFSP.realpath(root)) !== root
      )
        return [];
      const mountText =
        platform === "linux" ? await NodeFSP.readFile("/proc/self/mountinfo", "utf8") : "";
      const mounts =
        limits.mounts ??
        mountText.split("\n").flatMap((line) => {
          const encoded = line.split(" ")[4];
          return encoded
            ? [
                encoded.replace(/\\([0-7]{3})/g, (_, octal: string) =>
                  String.fromCharCode(Number.parseInt(octal, 8)),
                ),
              ]
            : [];
        });
      const device = (target: string, actual: number) => limits.device?.(target, actual) ?? actual;
      const safe = async (target: string) => {
        const stat = await NodeFSP.lstat(target);
        if (
          !inside(root, target) ||
          mounts.includes(target) ||
          device(target, stat.dev) !== rootStat.dev
        )
          throw new Error("Unsafe device or path");
        if (stat.isDirectory() && (await NodeFSP.realpath(target)) !== target)
          throw new Error("Directory changed");
        return stat;
      };
      const repository = (names: readonly string[]) =>
        names.includes(".git") || ["HEAD", "objects", "refs"].every((name) => names.includes(name));
      let entries = 0;
      const incomplete = new Error("Cleanup inspection exceeded its budget.");
      const namesAt = async (target: string) => {
        if (now() >= deadline || ++entries > limits.entries) throw incomplete;
        const stat = target === root ? rootStat : await safe(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Not a directory");
        if ((await NodeFSP.realpath(target)) !== target) throw new Error("Parent changed");
        const names = await NodeFSP.readdir(target);
        if (names.length + entries > limits.entries) throw incomplete;
        if (target !== root && repository(names)) throw new Error("Nested repository");
        return names;
      };
      const verify = async (target: string): Promise<void> => {
        if (now() >= deadline || ++entries > limits.entries) throw incomplete;
        const stat = await safe(target);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory())
          for (const name of await namesAt(target)) await verify(path.join(target, name));
        else if (!stat.isFile()) throw new Error("Special file");
      };
      const selected: string[] = [];
      const visit = async (target: string): Promise<void> => {
        if (now() >= deadline || ++entries > limits.entries) throw incomplete;
        const stat = await safe(target);
        if (stat.isSymbolicLink()) return;
        const relative = path.relative(root, target).split(path.sep).join("/");
        if (patterns.some((pattern) => matchesWorktreeCleanupPattern(pattern, relative))) {
          const key = canonical(relative);
          if (protectedPaths.some((entry) => entry === key || entry.startsWith(`${key}/`))) return;
          await verify(target);
          selected.push(target);
        }
      };
      for (const raw of ignoredPaths) {
        const parts = raw.replace(/\/$/, "").split("/");
        if (parts.some((part) => !part || part === "." || part === ".." || part === ".git"))
          continue;
        if (parts.some((_, index) => blockedAncestors.has(parts.slice(0, index).join("/"))))
          continue;
        try {
          let target = root;
          for (const part of parts) {
            if (!(await namesAt(target)).includes(part)) throw new Error("Missing path");
            target = path.join(target, part);
          }
          if (!selected.some((parent) => target === parent || inside(parent, target)))
            await visit(target);
        } catch (error) {
          if (error === incomplete || now() >= deadline) throw error;
          /* An unverifiable ignored subtree is kept whole. */
        }
      }
      return selected;
    });
  });
  const remove = Effect.fn("WorktreeCleanup.remove")(function* (
    root: string,
    target: string,
    budgetMs = 600_000,
  ) {
    const deadline = now() + budgetMs;
    return yield* Effect.tryPromise(async () => {
      const rootStat = await NodeFSP.lstat(root);
      if (
        !(await NodeFSP.lstat(path.join(root, ".git"))).isFile() ||
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        (await NodeFSP.realpath(root)) !== root
      )
        throw new Error("Root changed");
      const mounts =
        limits.mounts ??
        (platform === "linux"
          ? (await NodeFSP.readFile("/proc/self/mountinfo", "utf8"))
              .split("\n")
              .flatMap(
                (line) =>
                  line
                    .split(" ")[4]
                    ?.replace(/\\([0-7]{3})/g, (_, octal: string) =>
                      String.fromCharCode(Number.parseInt(octal, 8)),
                    ) ?? [],
              )
          : []);
      let bytes = 0;
      let entries = 0;
      // Idle worktrees and immediate directory checks limit risk; concurrent symlink swaps remain possible.
      const walk = async (current: string): Promise<void> => {
        if (now() >= deadline || !inside(root, current) || ++entries > limits.entries)
          throw new Error("Unsafe deletion path");
        const stat = await NodeFSP.lstat(current);
        if (
          mounts.includes(current) ||
          (limits.device?.(current, stat.dev) ?? stat.dev) !== rootStat.dev
        )
          throw new Error("Device changed");
        if (stat.isSymbolicLink()) await NodeFSP.unlink(current);
        else if (stat.isDirectory()) {
          if ((await NodeFSP.realpath(current)) !== current) throw new Error("Directory changed");
          const names = await NodeFSP.readdir(current);
          if (
            names.includes(".git") ||
            ["HEAD", "objects", "refs"].every((name) => names.includes(name))
          )
            throw new Error("Nested repository");
          for (const name of names) await walk(path.join(current, name));
          await NodeFSP.rmdir(current);
        } else if (stat.isFile()) {
          await NodeFSP.unlink(current);
          if (stat.nlink === 1) bytes += stat.blocks * 512;
        } else throw new Error("Special file");
      };
      // Resolve every parent again before entering a previously selected subtree.
      for (let parent = path.dirname(target); inside(root, parent); parent = path.dirname(parent)) {
        const stat = await NodeFSP.lstat(parent);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (await NodeFSP.realpath(parent)) !== parent
        )
          throw new Error("Parent changed");
      }
      if ((await NodeFSP.lstat(target)).isSymbolicLink()) throw new Error("Selected path changed");
      await walk(target);
      return bytes;
    });
  });
  return { inspect, remove };
});
