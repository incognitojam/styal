import type { ProjectScript } from "@t3tools/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

/**
 * A setup script is written against a fresh worktree: its cwd is the worktree and
 * `$T3CODE_PROJECT_ROOT` names a different directory. Where those are the same
 * directory - a thread on the main checkout - a line like
 * `ln -sf "$T3CODE_PROJECT_ROOT/.env" .env` replaces the file it meant to link to.
 * Callers refuse the run instead of falling back to the project root.
 */
export function isSetupScriptOutsideWorktree(input: {
  script: Pick<ProjectScript, "runOnWorktreeCreate">;
  projectCwd: string;
  worktreePath?: string | null;
}): boolean {
  if (!input.script.runOnWorktreeCreate) return false;
  if (!input.worktreePath) return true;
  return stripTrailingSeparators(input.worktreePath) === stripTrailingSeparators(input.projectCwd);
}

const stripTrailingSeparators = (value: string): string => value.replace(/[/\\]+$/, "");
