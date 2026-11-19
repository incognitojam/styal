// @effect-diagnostics nodeBuiltinImport:off -- Removal runs in an isolated CLI worker.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { WorktreeCleanupError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { matchesRegenerableFilePattern } from "@t3tools/shared/regenerableFilePatterns";
import { makeInspectGit } from "./gitInspection.ts";

export class DeletionLimits extends Context.Reference<{
  readonly entries: number;
  // Test-only preload for deterministic races inside the isolated worker.
  readonly helperPreload?: string;
  readonly mounts?: readonly string[];
  readonly now?: () => number;
  readonly device?: (target: string, actual: number) => number;
}>("worktreeCleanup/DeletionLimits", { defaultValue: () => ({ entries: 1_000_000 }) }) {}

class WorktreeCleanupIoError extends Schema.TaggedError<WorktreeCleanupIoError>()(
  "WorktreeCleanupIoError",
  { cause: Schema.Defect() },
) {}

export const makeDeletion = Effect.gen(function* () {
  const NodeFSP = yield* PhysicalFileSystem.PhysicalFileSystem;
  const clock = yield* Clock.Clock;
  const now = () => limits.now?.() ?? clock.currentTimeMillisUnsafe();
  const platform = yield* HostProcess.Platform;
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  const entry = NodeURL.fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
  );
  const canonical = (value: string) =>
    platform === "darwin"
      ? value.normalize("NFD").toLowerCase()
      : platform === "win32"
        ? value.toLowerCase()
        : value;
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
      (yield* Effect.tryPromise({
        try: async () =>
          (await NodeFSP.realpath(top.stdout.replace(/\r?\n$/, ""))) ===
          (await NodeFSP.realpath(root)),
        catch: (cause) => new WorktreeCleanupIoError({ cause }),
      }));
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
        if (!patterns.some((pattern) => matchesRegenerableFilePattern(pattern, `${parent}/`)))
          blockedAncestors.add(parent);
    }
    return yield* Effect.tryPromise({
      try: async () => {
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
        const device = (target: string, actual: number) =>
          limits.device?.(target, actual) ?? actual;
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
          names.includes(".git") ||
          ["HEAD", "objects", "refs"].every((name) => names.includes(name));
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
          if (
            patterns.some((pattern) =>
              matchesRegenerableFilePattern(
                pattern,
                stat.isDirectory() ? `${relative}/` : relative,
              ),
            )
          ) {
            const key = canonical(relative);
            if (protectedPaths.some((entry) => entry === key || entry.startsWith(`${key}/`)))
              return;
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
      },
      catch: (cause) => new WorktreeCleanupIoError({ cause }),
    });
  });
  const remove = Effect.fn("WorktreeCleanup.remove")(function* (
    root: string,
    target: string,
    budgetMs = 600_000,
  ) {
    const deadline = now() + budgetMs;
    const kept = new WorktreeCleanupError({
      reason: "run-failed",
      message: "Git protection changed or could not be verified; regenerable path kept.",
    });
    if (!inside(root, target) || now() >= deadline) return yield* kept;
    const relative = path.relative(root, target).split(path.sep).join("/");
    // Git pathspecs do not fold Unicode normalization like the macOS protection comparison.
    const scope = platform === "darwin" ? [] : ["--", `:(literal)${relative}`];
    const ignored = yield* git(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      ...scope,
    ]);
    const protectedOutput = yield* git(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      ...scope,
    ]);
    const key = canonical(relative);
    if (
      now() >= deadline ||
      [protectedOutput, ignored].some(
        (output) =>
          output.exitCode !== 0 ||
          output.stdoutTruncated ||
          output.stderrTruncated ||
          (output.stdout !== "" && !output.stdout.endsWith("\0")),
      ) ||
      protectedOutput.stdout
        .split("\0")
        .filter(Boolean)
        .map(canonical)
        .some((entry) => entry === key || entry.startsWith(`${key}/`)) ||
      !ignored.stdout
        .split("\0")
        .filter(Boolean)
        .some((entry) => {
          const parent = canonical(entry.replace(/\/$/, ""));
          return parent === key || key.startsWith(`${parent}/`);
        })
    )
      return yield* kept;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const rootStat = await NodeFSP.lstat(root, { bigint: true });
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
        if (platform === "win32" || !inside(root, target)) throw new Error("Unsafe deletion path");
        const remaining = deadline - now();
        if (remaining <= 0) throw new Error("Deletion budget exceeded");
        const stdout = await new Promise<string>((resolve, reject) => {
          NodeChildProcess.execFile(
            executable,
            [
              ...(isExecutable ? [] : [entry]),
              "__worktree-cleanup",
              root,
              path.relative(root, target).split(path.sep).join("/"),
              String(rootStat.dev),
              String(rootStat.ino),
              String(limits.entries),
              String(remaining),
              ...mounts.filter((mount) => inside(root, mount)),
            ],
            {
              signal,
              timeout: remaining,
              maxBuffer: 64 * 1024,
              encoding: "utf8",
              windowsHide: true,
              env: {
                ...environment,
                ELECTRON_RUN_AS_NODE: "1",
                NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""}${limits.helperPreload ? ` --import=${NodeURL.pathToFileURL(limits.helperPreload).href}` : ""}`,
              },
            },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
        });
        const bytes = Number(stdout);
        if (!stdout || !Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error("Invalid removal result");
        return bytes;
      },
      catch: (cause) => new WorktreeCleanupIoError({ cause }),
    });
  });
  return { inspect, remove };
});
