import {
  MAX_SCRIPT_ID_LENGTH,
  type ProjectScript,
  type StyalProjectFileScript,
} from "@t3tools/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

function normalizeProjectScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "script";
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const baseId = normalizeProjectScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (true) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) return safeCandidate;
    suffix += 1;
  }
}

export function projectScriptsFromStyalFile(
  scripts: ReadonlyArray<StyalProjectFileScript>,
): ReadonlyArray<ProjectScript> {
  const ids = new Set<string>();
  return scripts.map((script) => {
    const id = nextProjectScriptId(script.id ?? script.name, ids);
    ids.add(id);
    return {
      id,
      name: script.name,
      command: script.command,
      icon: script.icon ?? "play",
      runOnWorktreeCreate: script.setup ?? false,
    };
  });
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
    STYAL_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.STYAL_WORKTREE_PATH = input.worktreePath;
  }
  return withT3CodeProjectEnvironmentAliases(
    input.extraEnv === undefined ? env : { ...env, ...input.extraEnv },
  );
}

/** Adds legacy names only at the boundary where project processes receive their environment. */
export function withT3CodeProjectEnvironmentAliases(
  input: Record<string, string>,
): Record<string, string> {
  return {
    ...input,
    ...(input.STYAL_PROJECT_ROOT === undefined
      ? {}
      : { T3CODE_PROJECT_ROOT: input.STYAL_PROJECT_ROOT }),
    ...(input.STYAL_WORKTREE_PATH === undefined
      ? {}
      : { T3CODE_WORKTREE_PATH: input.STYAL_WORKTREE_PATH }),
    ...(input.STYAL_WORKSPACE_PORT === undefined
      ? {}
      : { T3CODE_WORKSPACE_PORT: input.STYAL_WORKSPACE_PORT }),
  };
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

/**
 * A setup script is written against a fresh worktree: its cwd is the worktree and
 * `$STYAL_PROJECT_ROOT` names a different directory. Where those are the same
 * directory - a thread on the main checkout - a line like
 * `ln -sf "$STYAL_PROJECT_ROOT/.env" .env` replaces the file it meant to link to.
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
