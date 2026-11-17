import * as Effect from "effect/Effect";
import { resolveProjectConfig } from "@t3tools/shared/projectFile";
import { makeInspectGit } from "./gitInspection.ts";

export const makeReadPatterns = Effect.gen(function* () {
  const inspectGit = yield* makeInspectGit;
  return Effect.fn("WorktreeCleanup.readPatterns")(function* (root: string) {
    const head = yield* inspectGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    let refs: readonly string[];
    if (head.exitCode === 0 && !head.stdoutTruncated) {
      const ref = head.stdout.trim();
      if (!ref.startsWith("refs/remotes/origin/") || ref.endsWith("/HEAD")) return [];
      refs = [ref];
    } else {
      const remotes = yield* inspectGit(root, ["remote"]);
      if (remotes.exitCode !== 0 || remotes.stdoutTruncated || remotes.stdout.trim()) return [];
      refs = ["refs/heads/main", "refs/heads/master"];
    }
    const prefix = yield* inspectGit(root, ["rev-parse", "--show-prefix"]);
    if (prefix.exitCode !== 0 || prefix.stdoutTruncated) return [];
    const filePath = `${prefix.stdout.replace(/\r?\n$/, "")}styal.json`;
    for (const ref of refs) {
      const exists = yield* inspectGit(root, ["show-ref", "--verify", "--quiet", ref]);
      if (exists.exitCode !== 0) continue;
      const file = yield* inspectGit(root, ["show", `${ref}:${filePath}`]);
      if (file.exitCode !== 0 || file.stdoutTruncated) return [];
      return resolveProjectConfig({ styal: file.stdout, t3: null }).config?.worktreeCleanup ?? [];
    }
    return [];
  });
});
