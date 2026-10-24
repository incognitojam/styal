import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type {
  CommandId,
  EnvironmentId,
  ProjectMutation,
  ProjectId,
  ServerConfig,
  SourceControlDefaultRepositoryRemote,
  SourceControlDefaultRepositoryState,
  SourceControlDiscoveryResult,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../state/projects.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { sourceControlClients } from "../sourceControlClients.ts";
import type { SourceControlClientDefinition } from "../sourceControlClients.ts";

export type AddProjectRemoteSource = SourceControlProviderKind | "url";

export function canCreateProjectInEnvironment(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export function availableScratchWorkspaceRoot(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
  serverConfig: Pick<ServerConfig, "scratchWorkspaceRoot"> | null | undefined,
): string | null {
  return canCreateProjectInEnvironment(connectionPhase)
    ? (serverConfig?.scratchWorkspaceRoot ?? null)
    : null;
}

export interface AddProjectRemoteSourceReadinessEntry {
  readonly ready: boolean;
  readonly hint: string | null;
}

export type AddProjectRemoteSourceReadiness = (
  source: AddProjectRemoteSource,
) => AddProjectRemoteSourceReadinessEntry;

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

const ADD_PROJECT_REMOTE_PROVIDER_SOURCES: ReadonlyArray<SourceControlProviderKind> =
  sourceControlClients.definitions.map((definition) => definition.kind);

export function addProjectRemoteSourceLabel(source: AddProjectRemoteSource): string {
  return source === "url" ? "Git URL" : sourceControlClients.get(source).pickerLabel;
}

export function addProjectRemoteSourcePathHint(source: AddProjectRemoteSource): string {
  return source === "url" ? "URL" : sourceControlClients.get(source).repositoryPathHint;
}

export function addProjectRemoteSourceProvider(
  source: AddProjectRemoteSource,
): SourceControlProviderKind | null {
  return source === "url" ? null : source;
}

export function parseAddProjectRemoteSource(
  value: string | null | undefined,
): AddProjectRemoteSource {
  return (value ? sourceControlClients.find(value)?.kind : undefined) ?? "url";
}

const REPOSITORY_SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/;

/**
 * The clone URL of `owner/name` on the public host of the host a repository reads as before it
 * reports one. Null when that host has no public host.
 */
export function defaultHostCloneUrl(repository: string): string | null {
  const definition = sourceControlClients.get(undefined);
  if (definition.publicHost === null) return null;
  const path = repository.endsWith(".git") ? repository : `${repository}.git`;
  return definition.defaultCloneTransport === "https"
    ? `https://${definition.publicHost}/${path}`
    : `git@${definition.publicHost}:${path}`;
}

export function normalizePastedCloneUrl(input: string): string {
  const trimmed = input.trim();
  return REPOSITORY_SHORTHAND.test(trimmed) ? (defaultHostCloneUrl(trimmed) ?? trimmed) : trimmed;
}

export function getDefaultCloneUrl(
  repository: Pick<SourceControlRepositoryInfo, "provider" | "url" | "sshUrl">,
): string {
  return sourceControlClients.get(repository.provider).defaultCloneTransport === "https"
    ? repository.url
    : repository.sshUrl;
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
  if (sourceControlClients.recognizeRemote(input.repositoryUrl)?.kind !== "github") {
    return null;
  }
  const owner = input.nameWithOwner.split("/")[0]?.trim();
  const host = normalizeGitRemoteUrl(input.repositoryUrl).split("/")[0];
  if (!owner || !host?.includes(".")) {
    return null;
  }
  return `https://${host}/${owner}.png?size=${input.size ?? 64}`;
}

// The remotes repository identity prefers when no default is set.
const PREFERRED_REMOTE_ORDER = ["upstream", "origin"];

function preferredRemoteRank(remoteName: string): number {
  const index = PREFERRED_REMOTE_ORDER.indexOf(remoteName);
  return index === -1 ? PREFERRED_REMOTE_ORDER.length : index;
}

/**
 * The repositories to offer when an existing checkout is added as a project, one
 * remote each, in the order repository identity ranks them, so the first is the
 * one that applies until a default is set. Empty when there is nothing to ask: a
 * default is already set (`gh repo set-default`), or the remotes name at most
 * one GitHub repository.
 */
export function addProjectDefaultRepositoryChoices(
  state: SourceControlDefaultRepositoryState,
): ReadonlyArray<SourceControlDefaultRepositoryRemote> {
  if (state.defaultRemoteName !== null) return [];
  const choices = new Map<string, SourceControlDefaultRepositoryRemote>();
  const ranked = [...state.remotes].sort(
    (left, right) =>
      preferredRemoteRank(left.remoteName) - preferredRemoteRank(right.remoteName) ||
      left.remoteName.localeCompare(right.remoteName),
  );
  for (const remote of ranked) {
    if (remote.provider !== "github" || remote.nameWithOwner === null) continue;
    const repository = normalizeGitRemoteUrl(remote.url);
    if (!choices.has(repository)) choices.set(repository, remote);
  }
  return choices.size > 1 ? [...choices.values()] : [];
}

export function sortAddProjectProviderSources(
  readiness: AddProjectRemoteSourceReadiness,
): ReadonlyArray<SourceControlProviderKind> {
  return Arr.sort(
    ADD_PROJECT_REMOTE_PROVIDER_SOURCES,
    Order.mapInput(
      Order.Struct({
        ready: Order.flip(Order.Boolean),
        label: Order.String,
      }),
      (source: SourceControlProviderKind) => ({
        ready: readiness(source).ready,
        label: addProjectRemoteSourceLabel(source),
      }),
    ),
  );
}

const READY: AddProjectRemoteSourceReadinessEntry = { ready: true, hint: null };
const UNAVAILABLE: AddProjectRemoteSourceReadinessEntry = {
  ready: false,
  hint: "Provider status unavailable. Open Source Control settings and rescan.",
};

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const providerByKind = new Map(
    (discovery?.sourceControlProviders ?? []).map((provider) => [provider.kind, provider]),
  );
  return (source) => {
    if (source === "url") return READY;
    const provider = providerByKind.get(source);
    if (!provider) return UNAVAILABLE;
    if (provider.status !== "available") return { ready: false, hint: provider.installHint };
    if (provider.auth.status === "unauthenticated") {
      return {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Source Control settings for setup guidance.`,
      };
    }
    return READY;
  };
}

/**
 * Where the Add Project browser opens: the environment's configured base
 * directory, else the default its server advertises, else home.
 */
export function getAddProjectInitialQuery(
  baseDirectory: string | null | undefined,
  defaultDirectory?: string | null,
): string {
  const trimmed = baseDirectory?.trim() ?? "";
  if (trimmed.length > 0) return ensureBrowseDirectoryPath(trimmed);
  const fallback = defaultDirectory?.trim() ?? "";
  return fallback.length > 0 ? ensureBrowseDirectoryPath(fallback) : "~/";
}

export function getCloneDirectoryName(repositoryOrRemoteUrl: string | null | undefined): string {
  const withoutQuery = (repositoryOrRemoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + "://".length) : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) {
    return "";
  }

  const lastSegment = segments.at(-1)?.trim() ?? "";
  if (hasHost && segments.length === 2 && /^\d+$/.test(lastSegment)) {
    return "";
  }
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -".git".length) : lastSegment;
}

export function getCloneDestinationPath(
  directoryPath: string,
  directoryName: string | null | undefined,
): string {
  const name = directoryName?.trim() ?? "";
  if (name.length === 0) {
    return directoryPath;
  }
  return `${ensureBrowseDirectoryPath(directoryPath)}${name}`;
}

export function getNewProjectPathPreview(newProjectsRoot: string, name: string): string {
  return getCloneDestinationPath(newProjectsRoot, newProjectFolderName(name));
}

export interface NewProjectPublishTarget {
  readonly definition: SourceControlClientDefinition;
  readonly owner: string | null;
}

export function getNewProjectPublishTargets(
  discovery: SourceControlDiscoveryResult | null,
): ReadonlyArray<NewProjectPublishTarget> {
  const readiness = buildAddProjectRemoteSourceReadiness(discovery);
  return sourceControlClients.definitions.flatMap((definition) => {
    if (!readiness(definition.kind).ready) return [];
    const provider = discovery?.sourceControlProviders.find(
      (candidate) => candidate.kind === definition.kind,
    );
    const placement = definition.newRepositoryOwner(
      provider ? Option.getOrNull(provider.auth.account) : null,
    );
    return placement === null ? [] : [{ definition, owner: placement.owner }];
  });
}

export function getNewProjectPublishTarget(
  targets: ReadonlyArray<NewProjectPublishTarget>,
  kind: SourceControlProviderKind | null,
): NewProjectPublishTarget | null {
  return targets.find((target) => target.definition.kind === kind) ?? targets[0] ?? null;
}

export function getNewProjectRepository(
  target: Pick<NewProjectPublishTarget, "owner">,
  workspaceRoot: string,
): string {
  const folderName = workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return target.owner ? `${target.owner}/${folderName}` : folderName;
}

export function getCloneDestinationBrowsePath(input: {
  readonly browseDirectoryPath: string;
  readonly selectedDirectoryName: string;
  readonly cloneDirectoryName: string;
  readonly caseSensitive: boolean;
}): string {
  const selectedDirectoryPath = appendBrowsePathSegment(
    input.browseDirectoryPath,
    input.selectedDirectoryName,
  );
  const selectedDirectoryMatches = input.caseSensitive
    ? input.selectedDirectoryName === input.cloneDirectoryName
    : input.selectedDirectoryName.toLowerCase() === input.cloneDirectoryName.toLowerCase();
  return selectedDirectoryMatches
    ? selectedDirectoryPath
    : getCloneDestinationPath(selectedDirectoryPath, input.cloneDirectoryName);
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
}): Extract<ProjectMutation, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: inferProjectTitleFromPath(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: null,
  };
}
