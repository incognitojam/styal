import { worktreeCleanupPatternProblem } from "@t3tools/contracts";

export function matchesWorktreeCleanupPattern(pattern: string, relative: string): boolean {
  if (worktreeCleanupPatternProblem(pattern) !== null) return false;
  const names = relative.split("/");
  if (names.some((name) => name === ".git" || name === "." || name === ".." || name === ""))
    return false;
  const parts = pattern.split("/");
  let reachable = new Set([0]);
  for (const part of parts) {
    const next = new Set<number>();
    for (const index of reachable) {
      if (part === "**") {
        for (let end = index; end <= names.length; end++) next.add(end);
      } else if (index < names.length) {
        const expression = part
          .split("*")
          .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*");
        if (new RegExp(`^${expression}$`).exec(names[index]!)?.[0] === names[index])
          next.add(index + 1);
      }
    }
    reachable = next;
  }
  return reachable.has(names.length);
}
