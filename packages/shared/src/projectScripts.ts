import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

/**
 * The project's override wins, then environment defaults. Until the legacy
 * fields have been folded into `projectSettingsOverrides`, the old map (null
 * there meant "reset to machine defaults") and the aggregate's own scripts
 * still count, so a server that has not run the fold yet behaves as before.
 */
export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

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
  return input.script.runOnWorktreeCreate && isProjectCheckoutRun(input);
}

/**
 * Whether a run would land in the project's own checkout rather than a separate
 * worktree. Setup and settle scripts are written for a worktree and skip it.
 */
export function isProjectCheckoutRun(input: {
  projectCwd: string;
  worktreePath?: string | null;
}): boolean {
  if (!input.worktreePath) return true;
  return stripTrailingSeparators(input.worktreePath) === stripTrailingSeparators(input.projectCwd);
}

/**
 * Setup and settle scripts each run as one finite command in a terminal named
 * `setup-<scriptId>` or `settle-<scriptId>`. The session is kept after exit so
 * its output stays inspectable, so nothing that wants a shell should land on it.
 */
export function isLifecycleScriptTerminalId(terminalId: string): boolean {
  return terminalId.startsWith("setup-") || terminalId.startsWith("settle-");
}

const stripTrailingSeparators = (value: string): string => value.replace(/[/\\]+$/, "");

/** Menu label naming the lifecycle roles a script runs in, e.g. "Clean (on settle)". */
export function projectScriptMenuLabel(
  script: Pick<ProjectScript, "name" | "runOnSettle"> & { readonly runOnWorktreeCreate?: boolean },
): string {
  const roles = [
    ...(script.runOnWorktreeCreate ? ["setup"] : []),
    ...(script.runOnSettle ? ["on settle"] : []),
  ];
  return roles.length === 0 ? script.name : `${script.name} (${roles.join(", ")})`;
}

export function settleProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnSettle === true) ?? null;
}
