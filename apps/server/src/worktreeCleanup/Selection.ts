import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import { type WorktreeCleanupKept, type WorktreeCleanupSelected } from "@t3tools/contracts";
import { matchesWorktreeCleanupPattern } from "@t3tools/shared/worktreeCleanupPatterns";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeMeasureWorktree } from "../storageCleanup.ts";

export const makeSelect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const measure = yield* makeMeasureWorktree;
  const platform = yield* HostProcess.Platform;
  const isLink = (target: string) =>
    fs.readLink(target).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) =>
          error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL",
        () => Effect.succeed(false),
      ),
    );
  return Effect.fn("WorktreeCleanup.select")(function* (root: string, patterns: readonly string[]) {
    const selected: WorktreeCleanupSelected[] = [];
    const kept: WorktreeCleanupKept[] = [];
    if (patterns.length === 0) return { selected, kept, freedBytes: 0, truncated: false };
    const read = (args: readonly string[]) =>
      git.execute({
        operation: "WorktreeCleanup.inspect",
        cwd: root,
        args,
        maxOutputBytes: 8 * 1024 * 1024,
      });
    const ignoredOutput = yield* read([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    const protectedOutput = yield* read([
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (ignoredOutput.stdoutTruncated || protectedOutput.stdoutTruncated)
      return { selected, kept, freedBytes: null, truncated: true };
    const ignored = ignoredOutput.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.replace(/\/$/, ""));
    const protectedPaths = protectedOutput.stdout.split("\0").filter(Boolean).sort();
    const rootStat = yield* fs.stat(root);
    // mountinfo includes same-device bind mounts, which device comparisons cannot detect.
    const mountText = platform === "linux" ? yield* fs.readFileString("/proc/self/mountinfo") : "";
    const mounts = mountText.split("\n").flatMap((line) => {
      const encoded = line.split(" ")[4];
      return encoded === undefined
        ? []
        : [
            encoded.replace(/\\([0-7]{3})/g, (_, digits: string) =>
              String.fromCharCode(Number.parseInt(digits, 8)),
            ),
          ];
    });
    let visited = 0;
    let truncated = false;
    const safety = Effect.fn("WorktreeCleanup.inspectCandidate")(function* (
      relative: string,
    ): Effect.fn.Return<
      { reason: WorktreeCleanupKept["reason"]; detail?: string } | null,
      PlatformError
    > {
      const pending = [relative];
      while (pending.length > 0) {
        if (++visited > 100_000) {
          truncated = true;
          return null;
        }
        const entry = pending.pop()!;
        const absolute = path.join(root, entry);
        if (yield* isLink(absolute)) return { reason: "symbolic-link", detail: entry };
        const stat = yield* fs.stat(absolute);
        if (stat.dev !== rootStat.dev || mounts.includes(absolute))
          return { reason: "mount-point", detail: entry };
        if (stat.type === "Directory") {
          const names = yield* fs.readDirectory(absolute);
          if (names.includes(".git")) return { reason: "nested-checkout", detail: entry };
          for (const name of names) pending.push(`${entry}/${name}`);
        }
      }
      return null;
    });
    const pending = [""];
    while (pending.length > 0) {
      if (++visited > 100_000 || selected.length + kept.length >= 1000) {
        truncated = true;
        break;
      }
      const relative = pending.pop()!;
      const absolute = path.join(root, relative);
      if (relative.split("/").includes(".git")) continue;
      const pattern =
        relative === ""
          ? undefined
          : patterns.find((candidate) => matchesWorktreeCleanupPattern(candidate, relative));
      const link = yield* isLink(absolute);
      const stat = link ? null : yield* fs.stat(absolute);
      if (pattern !== undefined) {
        let reason: { reason: WorktreeCleanupKept["reason"]; detail?: string } | null = link
          ? { reason: "symbolic-link" }
          : yield* safety(relative);
        if (truncated) break;
        const protectedPath = protectedPaths.find(
          (entry) => entry === relative || entry.startsWith(`${relative}/`),
        );
        if (reason === null && protectedPath !== undefined)
          reason = {
            reason: stat?.type === "Directory" ? "contains-tracked-files" : "not-ignored",
            detail: protectedPath,
          };
        if (
          reason === null &&
          !ignored.some((entry) => entry === relative || relative.startsWith(`${entry}/`))
        )
          reason = { reason: "not-ignored" };
        if (reason !== null) kept.push({ path: relative, pattern, ...reason });
        else
          selected.push({
            path: relative,
            pattern,
            kind: stat?.type === "Directory" ? "directory" : "file",
            freedBytes: yield* measure(root, absolute),
          });
        continue;
      }
      if (link || stat?.dev !== rootStat.dev || mounts.includes(absolute)) continue;
      if (stat?.type === "Directory") {
        const names = (yield* fs.readDirectory(absolute)).sort().reverse();
        if (relative !== "" && names.includes(".git")) continue;
        for (const name of names)
          if (name !== ".git") pending.push(relative === "" ? name : `${relative}/${name}`);
      }
    }
    return {
      selected,
      kept,
      freedBytes:
        truncated || selected.some((entry) => entry.freedBytes === null)
          ? null
          : selected.reduce((sum, entry) => sum + entry.freedBytes!, 0),
      truncated,
    };
  }, Effect.timeout("30 seconds"));
});
