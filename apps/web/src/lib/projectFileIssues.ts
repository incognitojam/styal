import type { ProjectFileIssue } from "@t3tools/shared/projectFile";
import { findNodeAtLocation, parseTree } from "jsonc-parser";

/**
 * Each issue as display text, starting with the line its value is on, the same
 * way a keybindings.json issue does. The line is left out if the path has no node.
 */
export function describeProjectFileIssues(
  contents: string,
  issues: ReadonlyArray<ProjectFileIssue>,
): ReadonlyArray<string> {
  const tree = parseTree(contents, [], { allowTrailingComma: true });
  return issues.map((issue) => {
    const node = tree && findNodeAtLocation(tree, [...issue.path]);
    if (!node) return issue.message;
    // An object field starts at its key, not at its value.
    const offset = node.parent?.type === "property" ? node.parent.offset : node.offset;
    return `Line ${contents.slice(0, offset).split("\n").length}: ${issue.message}`;
  });
}
