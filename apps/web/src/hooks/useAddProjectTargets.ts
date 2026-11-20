import {
  canCreateProjectInEnvironment,
  getAddProjectInitialQuery,
  getCloneDestinationPath,
  getCloneDirectoryPath,
} from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthSourceControlWriteScope,
  resolveEnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { useEnvironments } from "../state/environments";
import { useEnvironmentsWithScope } from "../state/session";

export type AddProjectTarget = Pick<EnvironmentOption, "environmentId" | "label" | "machine"> & {
  /** The folder the clone lands in unless another is chosen. */
  readonly destinationPath: string;
};

export function projectCloneSourceUrl(project: EnvironmentProject | null): string {
  return (
    project?.repositoryIdentity?.origin?.remoteUrl ??
    project?.repositoryIdentity?.locator.remoteUrl ??
    ""
  );
}

/** The target machine's add-project folder, then the repository's folder name inside it. */
export function defaultCloneDestination(
  sourceUrl: string,
  serverConfig: Pick<ServerConfig, "settings" | "addProjectDefaultDirectory"> | null | undefined,
): string {
  return getCloneDestinationPath(
    getAddProjectInitialQuery(
      serverConfig?.settings.addProjectBaseDirectory,
      serverConfig?.addProjectDefaultDirectory,
    ),
    getCloneDirectoryPath(sourceUrl, serverConfig?.settings.ghqCloneLayout === true),
  );
}

/**
 * Connected machines that do not have the project yet and can clone it.
 * `projectEnvironments` is the project's current machine list, from
 * `useLogicalProjectEnvironments`. Projects without a git remote get none.
 */
export function useAddProjectTargets(
  project: EnvironmentProject | null,
  projectEnvironments: readonly Pick<EnvironmentOption, "environmentId">[] | undefined,
): readonly AddProjectTarget[] {
  const { environments } = useEnvironments();
  const canClone = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);
  if (!project?.repositoryIdentity?.locator.remoteUrl) return [];
  const sourceUrl = projectCloneSourceUrl(project);
  const hasProject = new Set([
    project.environmentId,
    ...(projectEnvironments ?? []).map((env) => env.environmentId),
  ]);
  return environments
    .filter(
      (environment) =>
        !hasProject.has(environment.environmentId) &&
        canClone.has(environment.environmentId) &&
        canCreateProjectInEnvironment(environment.connection.phase) &&
        environment.serverConfig !== null,
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      machine: resolveEnvironmentMachineKind(environment.serverConfig),
      destinationPath: defaultCloneDestination(sourceUrl, environment.serverConfig),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}
