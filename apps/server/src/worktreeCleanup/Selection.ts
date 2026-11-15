import * as Clock from "effect/Clock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import { type WorktreeCleanupKept, type WorktreeCleanupSelected } from "@t3tools/contracts";
import { matchesWorktreeCleanupPattern } from "@t3tools/shared/worktreeCleanupPatterns";
import * as StorageCleanup from "../storageCleanup.ts";
import { makeInspectGit } from "./gitInspection.ts";

export class SelectionLimits extends Context.Reference<{
  readonly verificationEntries: number;
  readonly traversalEntries: number;
  readonly reportEntries: number;
}>("@styal/cli/worktreeCleanup/Selection/SelectionLimits", {
  defaultValue: () => ({
    verificationEntries: 1_000_000,
    traversalEntries: 1_000_000,
    reportEntries: 1000,
  }),
}) {}

export const makeSelect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inspectGit = yield* makeInspectGit;
  const { measureWorktree: measure } = yield* StorageCleanup.StorageCleanup;
  const platform = yield* HostProcess.Platform;
  const limits = yield* SelectionLimits;
  const isLink = (target: string) =>
    fs.readLink(target).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) =>
          error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL",
        () => Effect.succeed(false),
      ),
    );
  return Effect.fn("WorktreeCleanup.select")(function* (
    root: string,
    patterns: readonly string[],
    declaredPatterns: readonly string[] = patterns,
    approvedPatterns: ReadonlySet<string> = new Set(patterns),
    previewDeadline?: number,
  ) {
    const deadline = previewDeadline ?? (yield* Clock.currentTimeMillis) + 30_000;
    const progress: { activeCandidate: { path: string; pattern: string } | null } = {
      activeCandidate: null,
    };
    let candidateFilesSeen = 0;
    const selected: WorktreeCleanupSelected[] = [];
    const kept: WorktreeCleanupKept[] = [];
    const report = (entriesTruncated: boolean) => {
      const measurementComplete =
        !entriesTruncated &&
        !kept.some((entry) => entry.reason === "too-large-to-verify") &&
        selected.every((entry) => entry.freedBytes !== null);
      return {
        selected,
        kept,
        freedBytes: measurementComplete
          ? selected
              .filter((entry) => entry.insideSelected === null)
              .reduce((sum, entry) => sum + entry.freedBytes!, 0)
          : null,
        entriesTruncated,
        measurementComplete,
      };
    };
    if (patterns.length === 0) return report(false);
    const walk = Effect.gen(function* () {
      const ignoredOutput = yield* inspectGit(root, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ]);
      const protectedOutput = yield* inspectGit(root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      if (ignoredOutput.stdoutTruncated || protectedOutput.stdoutTruncated) return report(true);
      const ignored = ignoredOutput.stdout
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.replace(/\/$/, ""));
      const protectedPaths = protectedOutput.stdout.split("\0").filter(Boolean).sort();
      const rootStat = yield* fs.stat(root);
      // mountinfo includes same-device bind mounts, which device comparisons cannot detect.
      const mountText =
        platform === "linux" ? yield* fs.readFileString("/proc/self/mountinfo") : "";
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
      const repository = Effect.fn("WorktreeCleanup.isRepository")(function* (
        absolute: string,
        names: readonly string[],
      ) {
        if (names.includes(".git")) return true;
        if (!names.includes("HEAD") || !names.includes("objects") || !names.includes("refs"))
          return false;
        if (
          (yield* isLink(path.join(absolute, "objects"))) ||
          (yield* isLink(path.join(absolute, "refs")))
        )
          return true;
        return (
          (yield* fs.stat(path.join(absolute, "objects"))).type === "Directory" &&
          (yield* fs.stat(path.join(absolute, "refs"))).type === "Directory"
        );
      });
      const safety = Effect.fn("WorktreeCleanup.inspectCandidate")(function* (relative: string) {
        const pending = [relative];
        let visited = 0;
        let filesSeen = 0;
        candidateFilesSeen = 0;
        const tooLarge = () => ({
          reason: "too-large-to-verify" as const,
          detail: `${filesSeen} files inspected before verification stopped`,
        });
        // Batches share the candidate's span and yield between asynchronous filesystem probes.
        const inspect = Effect.fnUntraced(function* (
          entry: string,
        ): Effect.fn.Return<WorktreeCleanupKept | null, PlatformError> {
          const absolute = path.join(root, entry);
          const base = { path: relative, pattern: "" };
          if (yield* isLink(absolute)) return { ...base, reason: "symbolic-link", detail: entry };
          const stat = yield* fs.stat(absolute);
          if (stat.type === "File") {
            filesSeen++;
            candidateFilesSeen = filesSeen;
          }
          if (stat.dev !== rootStat.dev || mounts.includes(absolute))
            return { ...base, reason: "mount-point", detail: entry };
          if (stat.type === "Directory") {
            const names = yield* fs.readDirectory(absolute);
            if (yield* repository(absolute, names))
              return { ...base, reason: "nested-checkout", detail: entry };
            for (const name of names) pending.push(`${entry}/${name}`);
          }
          return null;
        });
        const walk = Effect.gen(function* () {
          while (pending.length > 0) {
            if (visited >= limits.verificationEntries) return tooLarge();
            const batch = pending.splice(-Math.min(64, limits.verificationEntries - visited));
            if (batch.length === 0) return tooLarge();
            visited += batch.length;
            const results = yield* Effect.forEach(batch, inspect, { concurrency: 64 });
            const refused = results.find((result) => result !== null);
            if (refused)
              return {
                reason: refused.reason,
                ...(refused.detail === undefined ? {} : { detail: refused.detail }),
              };
            yield* Effect.yieldNow;
          }
          return null;
        });
        const result = yield* walk.pipe(
          Effect.timeoutOption(Math.max(1, deadline - (yield* Clock.currentTimeMillis))),
        );
        return Option.isNone(result) ? tooLarge() : result.value;
      });
      const pending = [""];
      let visited = 0;
      while (pending.length > 0) {
        if (
          (yield* Clock.currentTimeMillis) >= deadline ||
          ++visited > limits.traversalEntries ||
          selected.length + kept.length >= limits.reportEntries
        )
          return report(true);
        if (visited % 64 === 0) yield* Effect.yieldNow;
        const relative = pending.pop()!;
        const absolute = path.join(root, relative);
        if (relative.split("/").includes(".git")) continue;
        const matching =
          relative === ""
            ? []
            : declaredPatterns.filter((candidate) =>
                matchesWorktreeCleanupPattern(candidate, relative),
              );
        const candidate = matching.some((pattern) => patterns.includes(pattern));
        const pattern = matching.find((pattern) => approvedPatterns.has(pattern)) ?? matching[0];
        const link = yield* isLink(absolute);
        const stat = link ? null : yield* fs.stat(absolute);
        if (candidate && pattern !== undefined) {
          progress.activeCandidate = { path: relative, pattern };
          let reason = link ? { reason: "symbolic-link" as const } : yield* safety(relative);
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
          else {
            const measured = yield* measure(root, absolute).pipe(
              Effect.timeoutOption(Math.max(1, deadline - (yield* Clock.currentTimeMillis))),
            );
            const freedBytes = Option.getOrNull(measured);
            if (freedBytes === null)
              kept.push({
                path: relative,
                pattern,
                reason: "too-large-to-verify",
                detail: `${candidateFilesSeen} files inspected; measurement incomplete`,
              });
            else
              selected.push({
                path: relative,
                pattern,
                patterns: matching,
                insideSelected:
                  selected.findLast((entry) => relative.startsWith(`${entry.path}/`))?.path ?? null,
                patternStatus: matching.some((pattern) => approvedPatterns.has(pattern))
                  ? "approved"
                  : "pending",
                kind: stat?.type === "Directory" ? "directory" : "file",
                freedBytes,
              });
          }
          progress.activeCandidate = null;
          if (stat?.type !== "Directory") continue;
          const names = relative.split("/");
          const hasDescendantPattern = declaredPatterns.some((pattern) => {
            const parts = pattern.split("/");
            if (parts.includes("**")) return true;
            return (
              parts.length > names.length &&
              names.every((name, index) => {
                const expression = parts[index]!.split("*")
                  .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                  .join(".*");
                return new RegExp(`^${expression}$`).test(name);
              })
            );
          });
          if (!hasDescendantPattern) continue;
        }
        if (link || stat?.dev !== rootStat.dev || mounts.includes(absolute)) continue;
        if (stat?.type === "Directory") {
          const names = (yield* fs.readDirectory(absolute)).sort().reverse();
          if (relative !== "" && (yield* repository(absolute, names))) continue;
          for (const name of names)
            if (name !== ".git") pending.push(relative === "" ? name : `${relative}/${name}`);
        }
      }
      return report(false);
    });
    const result = yield* walk.pipe(
      Effect.timeoutOption(Math.max(1, deadline - (yield* Clock.currentTimeMillis))),
    );
    if (Option.isSome(result)) return result.value;
    if (progress.activeCandidate !== null)
      kept.push({
        ...progress.activeCandidate,
        reason: "too-large-to-verify",
        detail: `${candidateFilesSeen} files inspected before verification stopped`,
      });
    return report(true);
  });
});
