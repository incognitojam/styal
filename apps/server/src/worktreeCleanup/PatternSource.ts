import * as Effect from "effect/Effect";
import { resolveProjectConfig } from "@t3tools/shared/projectFile";
import { makeInspectGit } from "./gitInspection.ts";

const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
const read = (patterns: readonly string[]) => ({ status: "read" as const, patterns });

export const makeReadPatterns = Effect.gen(function* () {
  const inspectGit = yield* makeInspectGit;
  return Effect.fn("WorktreeCleanup.readPatterns")(function* (root: string) {
    const head = yield* inspectGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    let ref: string;
    if (head.exitCode === 0 && !head.stdoutTruncated) {
      ref = head.stdout.trim();
      if (!ref.startsWith("refs/remotes/origin/") || ref.endsWith("/HEAD"))
        return unavailable("The origin remote's default branch cannot be resolved.");
    } else {
      const remotes = yield* inspectGit(root, ["remote"]);
      if (remotes.exitCode !== 0 || remotes.stdoutTruncated)
        return unavailable("The project's Git remotes cannot be read.");
      if (remotes.stdout.trim())
        return unavailable("The origin remote's default branch is unknown. Cleanup is skipped.");
      const configured = yield* inspectGit(root, ["config", "--get", "init.defaultBranch"]);
      if (configured.stdoutTruncated || configured.exitCode > 1)
        return unavailable("The project's configured default branch cannot be read.");
      if (configured.stdout.trim()) {
        ref = `refs/heads/${configured.stdout.trim()}`;
      } else {
        const current = yield* inspectGit(root, ["symbolic-ref", "--quiet", "HEAD"]);
        if (current.exitCode !== 0 || current.stdoutTruncated)
          return unavailable("The registered checkout has no identifiable default branch.");
        ref = current.stdout.trim();
        if (!ref.startsWith("refs/heads/"))
          return unavailable("The registered checkout's branch cannot be resolved.");
      }
    }
    const prefix = yield* inspectGit(root, ["rev-parse", "--show-prefix"]);
    if (prefix.exitCode !== 0 || prefix.stdoutTruncated)
      return unavailable("The project's path in its Git repository cannot be read.");
    const filePath = `${prefix.stdout.replace(/\r?\n$/, "")}styal.json`;
    const exists = yield* inspectGit(root, ["show-ref", "--verify", "--quiet", ref]);
    if (exists.exitCode !== 0)
      return unavailable("The default branch revision is not available in this checkout.");
    const file = yield* inspectGit(root, ["show", `${ref}:${filePath}`]);
    if (file.exitCode !== 0) {
      const listed = yield* inspectGit(root, ["ls-tree", "--full-tree", "-z", ref, "--", filePath]);
      if (listed.exitCode === 0 && !listed.stdoutTruncated && listed.stdout.length === 0)
        return read([]);
      return unavailable("The project's styal.json cannot be read from the default branch.");
    }
    if (file.stdoutTruncated)
      return unavailable("The project's styal.json is too large to inspect.");
    const resolved = resolveProjectConfig({ styal: file.stdout, t3: null });
    if (resolved.config === null)
      return unavailable("The project's styal.json could not be parsed.");
    const patterns = resolved.config.regenerableFiles;
    if (
      patterns === undefined &&
      resolved.issues.some(
        (issue) => issue.path[0] === "regenerableFiles" || issue.path[0] === "worktreeCleanup",
      )
    )
      return unavailable("The cleanup patterns in styal.json could not be parsed.");
    return read(patterns ?? []);
  });
});
