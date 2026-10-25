import {
  MAX_SCRIPT_ID_LENGTH,
  type ProjectConfig,
  type ProjectConfigAction,
  type ProjectFileActionApproval,
  type ProjectFileActionRole,
  type ProjectId,
  type ProjectScript,
  type RepositoryIdentity,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  approvedFileActionRoles,
  declaredFileActionRoles,
  projectFileApprovalKey,
} from "./projectFileApprovals.ts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

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

/**
 * Where an action in the menu comes from:
 * - `local`: saved in styal for this project or environment.
 * - `file`: declared in the project's styal.json and read live from it.
 * - `override`: saved locally under the id of a styal.json action, replacing it.
 */
export type ProjectActionSource = "local" | "file" | "override";

export type ResolvedProjectAction = ProjectScript & {
  readonly source: ProjectActionSource;
  /**
   * Automatic roles a file action declares but may not run in yet, because
   * its exact command has not been approved. Absent when there are none.
   */
  readonly awaitingApproval?: readonly ProjectFileActionRole[];
};

/**
 * `config` must come from the project root so every thread sees the same file actions. A file
 * action runs automatically for a role only after the user approves its exact command; until
 * then it lists that role in `awaitingApproval`.
 */
export function resolveProjectActions(
  settings: ProjectScriptSettings & Pick<ServerSettings, "projectFileActionApprovals">,
  project: {
    id: ProjectId;
    scripts: readonly ProjectScript[];
    workspaceRoot: string;
    repositoryIdentity?: RepositoryIdentity | null | undefined;
  },
  config: Pick<ProjectConfig, "actions"> | null,
): readonly ResolvedProjectAction[] {
  return mergeProjectActions(
    resolveProjectScripts(settings, project),
    config,
    settings.projectFileActionApprovals[projectFileApprovalKey(project)] ?? {},
  );
}

/** `resolveProjectActions` for a caller that already holds the saved list and approvals. */
export function mergeProjectActions(
  saved: readonly ProjectScript[],
  config: Pick<ProjectConfig, "actions"> | null,
  approvals: Readonly<Record<string, ProjectFileActionApproval>>,
): readonly ResolvedProjectAction[] {
  const fileActions = config?.actions ?? [];
  const fileIds = new Set(fileActions.map((action) => action.id));
  const savedIds = new Set(saved.map((script) => script.id));
  return [
    ...saved.map((script) => ({
      ...script,
      source: fileIds.has(script.id) ? ("override" as const) : ("local" as const),
    })),
    ...fileActions
      .filter((action) => !savedIds.has(action.id))
      .map((action) => fileProjectAction(action, approvals[action.id])),
  ];
}

function fileProjectAction(
  action: ProjectConfigAction,
  approval: ProjectFileActionApproval | undefined,
): ResolvedProjectAction {
  const approved = approvedFileActionRoles(action, approval);
  const awaiting = declaredFileActionRoles(action).filter((role) => !approved.includes(role));
  const setup = approved.includes("setup");
  return {
    id: action.id,
    name: action.name,
    command: action.command,
    icon: action.icon,
    runOnWorktreeCreate: setup,
    ...(approved.includes("settle") ? { runOnSettle: true } : {}),
    ...(setup && action.async === false ? { async: false } : {}),
    source: "file",
    ...(awaiting.length > 0 ? { awaitingApproval: awaiting } : {}),
  };
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
 * On the main checkout the cwd and `$STYAL_PROJECT_ROOT` are the same directory, so a line like
 * `ln -sf "$STYAL_PROJECT_ROOT/.env" .env` replaces the file it meant to link to. Callers refuse
 * the run instead of falling back to the project root.
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

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

/** A keybinding-safe id derived from `name` that none of `existingIds` uses. */
export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  // Every suffix gives a distinct id, so this ends within taken.size + 1 tries.
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
  }
}

/**
 * Leading spaces omit scripts from Bash history with ignorespace/ignoreboth,
 * zsh with HIST_IGNORE_SPACE, and fish. Only the first line is prefixed, so later
 * entries from multiline input may still enter history. PowerShell/PSReadLine history is not suppressed.
 */
export function projectScriptTerminalInput(command: string): string {
  return ` ${command}\r`;
}
