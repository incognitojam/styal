import {
  repositoryGroupingKeyOf,
  type ProjectConfigAction,
  type ProjectFileActionApproval,
  type ProjectFileActionRole,
  type ProjectId,
  type RepositoryIdentity,
} from "@t3tools/contracts";

import { normalizeProjectPathForComparison } from "./path.ts";

/**
 * A fork's own remote ranks first so a fork never shares approvals with its upstream, and the
 * path inside the repository keeps monorepo projects apart. Without a known repository the
 * approvals belong to the project alone.
 */
export function projectFileApprovalKey(project: {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}): string {
  const repository = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  if (!repository) return `project:${project.id}`;
  const relative = repositoryRelativePath(project.workspaceRoot, project.repositoryIdentity);
  return relative === null || relative.length === 0 ? repository : `${repository}::${relative}`;
}

function repositoryRelativePath(
  workspaceRoot: string,
  identity: RepositoryIdentity | null | undefined,
): string | null {
  const rootPath = identity?.rootPath?.trim();
  if (!rootPath) return null;
  const project = normalizeProjectPathForComparison(workspaceRoot);
  const root = normalizeProjectPathForComparison(rootPath);
  if (project.length === 0 || root.length === 0) return null;
  if (project === root) return "";
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = `${root}${separator}`;
  return project.startsWith(prefix) ? project.slice(prefix.length).replaceAll("\\", "/") : null;
}

/** The automatic roles a file action declares. */
export function declaredFileActionRoles(
  action: Pick<ProjectConfigAction, "runOnWorktreeCreate" | "runOnSettle">,
): readonly ProjectFileActionRole[] {
  return [
    ...(action.runOnWorktreeCreate === true ? (["setup"] as const) : []),
    ...(action.runOnSettle === true ? (["settle"] as const) : []),
  ];
}

/**
 * The declared roles an approval covers. Any change to the command, however
 * small, voids the approval, as does asking for a role it did not include.
 */
export function approvedFileActionRoles(
  action: Pick<ProjectConfigAction, "command" | "runOnWorktreeCreate" | "runOnSettle">,
  approval: ProjectFileActionApproval | undefined,
): readonly ProjectFileActionRole[] {
  if (approval === undefined || approval.command !== action.command) return [];
  return declaredFileActionRoles(action).filter((role) => approval.roles.includes(role));
}

const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "node",
  "python",
  "python3",
  "tsx",
  "bun",
  "deno",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "vp"]);
// Package-manager subcommands that are not script names.
const PACKAGE_MANAGER_COMMANDS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "exec",
  "dlx",
  "x",
  "test",
  "ci",
  "update",
  "upgrade",
]);

/** Words of a shell command, honouring single and double quotes; good enough for hints. */
export function splitCommandWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char) || char === ";" || char === "&" || char === "|") {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

/**
 * Candidates for files a command runs, for the approval's warning that later
 * edits to them run without asking again. `paths` are project-relative and
 * still need an existence check; `packageScript` names a package.json script
 * run through a package manager. A hint, never a security check.
 */
export function commandFileCandidates(command: string): {
  readonly paths: readonly string[];
  readonly packageScripts: readonly string[];
} {
  const words = splitCommandWords(command);
  const paths: string[] = [];
  const packageScripts: string[] = [];
  words.forEach((word, index) => {
    const previous = index > 0 ? words[index - 1] : undefined;
    const looksRelative =
      !word.startsWith("-") &&
      !word.startsWith("/") &&
      !word.startsWith("~") &&
      !word.includes("$") &&
      !word.includes("..") &&
      (word.startsWith("./") || /^[\w.-]+\/[\w./-]*[\w-]$/.test(word));
    if (
      looksRelative ||
      (previous !== undefined &&
        INTERPRETERS.has(previous) &&
        /^[\w./-]+$/.test(word) &&
        !word.startsWith("-") &&
        !word.includes(".."))
    ) {
      const path = word.replace(/^\.\//, "");
      if (path.length > 0 && !paths.includes(path)) paths.push(path);
    }
    if (word !== undefined && PACKAGE_MANAGERS.has(word)) {
      const next = words[index + 1];
      const script = next === "run" ? words[index + 2] : next;
      if (
        script !== undefined &&
        /^[\w:.-]+$/.test(script) &&
        !PACKAGE_MANAGER_COMMANDS.has(script) &&
        script !== "run" &&
        !packageScripts.includes(script)
      ) {
        packageScripts.push(script);
      }
    }
  });
  return { paths, packageScripts };
}
