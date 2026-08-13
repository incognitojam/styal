import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type {
  CommandId,
  EnvironmentId,
  OrchestrationCommand,
  ProjectId,
  SourceControlDiscoveryResult,
  SourceControlProviderKind,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import {
  ensureBrowseDirectoryPath,
  findProjectByPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../state/projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

export type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;
export type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

export function canCreateProjectInEnvironment(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>;

export type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

const ADD_PROJECT_REMOTE_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  "url",
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

const ADD_PROJECT_REMOTE_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

export function addProjectRemoteSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

export function addProjectRemoteSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

export function addProjectRemoteSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

/**
 * GitHub, including Enterprise hosts, serves an owner's avatar at `/<login>.png`,
 * so one remote URL is enough to show who owns a repository without an API call.
 * The URL may be either transport, since clone flows carry the SSH one. Other
 * providers have no such path, so this returns null rather than sending the
 * client after a guaranteed 404; callers fall back to the provider icon, which
 * is also what they should do when the image fails to load.
 */
export function repositoryOwnerAvatarUrl(input: {
  readonly repositoryUrl: string;
  readonly nameWithOwner: string;
  readonly size?: number;
}): string | null {
  if (detectSourceControlProviderFromGitRemoteUrl(input.repositoryUrl)?.kind !== "github") {
    return null;
  }
  const owner = input.nameWithOwner.split("/")[0]?.trim();
  const host = normalizeGitRemoteUrl(input.repositoryUrl).split("/")[0];
  if (!owner || !host?.includes(".")) {
    return null;
  }
  return `https://${host}/${owner}.png?size=${input.size ?? 64}`;
}

export function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind> {
  return Arr.sort(
    ADD_PROJECT_REMOTE_PROVIDER_SOURCES,
    Order.mapInput(
      Order.Struct({
        ready: Order.flip(Order.Boolean),
        label: Order.String,
      }),
      (source: AddProjectRemoteProviderKind) => ({
        ready: readinessBySource[source].ready,
        label: addProjectRemoteSourceLabel(source),
      }),
    ),
  );
}

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const unavailable = {
    ready: false,
    hint: "Provider status unavailable. Open Source Control settings and rescan.",
  } as const;
  const readiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };

  if (!discovery) {
    return readiness;
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  );
  for (const source of ADD_PROJECT_REMOTE_SOURCES) {
    const kind = addProjectRemoteSourceProvider(source);
    if (!kind) continue;
    const provider = providerByKind.get(kind);
    if (!provider) {
      readiness[source] = unavailable;
      continue;
    }
    if (provider.status !== "available") {
      readiness[source] = { ready: false, hint: provider.installHint };
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness[source] = {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Source Control settings for setup guidance.`,
      };
      continue;
    }
    readiness[source] = { ready: true, hint: null };
  }
  return readiness;
}

export function getAddProjectInitialQuery(baseDirectory: string | null | undefined): string {
  const trimmed = baseDirectory?.trim() ?? "";
  return trimmed.length === 0 ? "~/" : ensureBrowseDirectoryPath(trimmed);
}

function inferCloneDirectoryName(value: string): string {
  const withoutTrailingSeparators = value.trim().replace(/[/\\]+$/, "");
  const leaf =
    withoutTrailingSeparators
      .replace(/\.git$/i, "")
      .split(/[/\\:]/)
      .findLast((segment) => segment.length > 0) ?? "";
  return leaf === "." || leaf === ".." ? "" : leaf;
}

/**
 * Default clone destination: the add-project parent directory with the
 * repository's own directory name appended, matching the directory `git clone`
 * would create. The name is left without a trailing separator so browsing still
 * treats it as a partial leaf the user can edit or replace.
 */
export function getCloneDestinationQuery(input: {
  readonly parentPath: string;
  readonly nameWithOwner?: string | null;
  readonly remoteUrl?: string | null;
}): string {
  const directoryName =
    inferCloneDirectoryName(input.nameWithOwner ?? "") ||
    inferCloneDirectoryName(input.remoteUrl ?? "");
  return directoryName.length === 0
    ? input.parentPath
    : `${ensureBrowseDirectoryPath(input.parentPath)}${directoryName}`;
}

export function resolveAddProjectPath(input: {
  readonly rawPath: string;
  readonly currentProjectCwd?: string | null;
  readonly platform: string;
}): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const rawPath = input.rawPath.trim();
  if (rawPath.length === 0) {
    return { ok: false, error: "Enter a project path." };
  }
  if (isUnsupportedWindowsProjectPath(rawPath, input.platform)) {
    return { ok: false, error: "Windows-style paths are only supported on Windows environments." };
  }
  if (isExplicitRelativeProjectPath(rawPath) && !input.currentProjectCwd) {
    return { ok: false, error: "Relative paths require an active project in this environment." };
  }
  const path = resolveProjectPathForDispatch(rawPath, input.currentProjectCwd);
  return path.length === 0 ? { ok: false, error: "Enter a project path." } : { ok: true, path };
}

export function findExistingAddProject(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly path: string;
}): EnvironmentProject | null {
  return (
    findProjectByPath(
      input.projects.filter((project) => project.environmentId === input.environmentId),
      input.path,
    ) ?? null
  );
}

export function buildProjectCreateCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: inferProjectTitleFromPath(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: null,
    createdAt: input.createdAt,
  };
}
