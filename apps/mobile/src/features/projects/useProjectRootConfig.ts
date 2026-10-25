import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  STYAL_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectConfig,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import { resolveProjectConfig } from "@t3tools/shared/projectFile";
import { useMemo } from "react";

import { useEnvironmentPresentation } from "../../state/presentation";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";

/**
 * The directory a project's shared configuration is read from: the
 * registered project root, never a thread's worktree, so every thread of the
 * project sees the same file actions. The one place to change that source.
 */
export function projectConfigRoot(project: { readonly workspaceRoot: string }): string {
  return project.workspaceRoot;
}

const contentsOf = (data: ProjectReadFileResult | null) =>
  data === null || data.exists === false || data.truncated ? null : data.contents;

/**
 * Reads styal.json, or a legacy t3.json without one. `pending` stays true while file access is
 * unknown and until the styal.json read settles, so a legacy file never decides ahead of its
 * replacement.
 */
export function useProjectRootConfig(
  project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string } | null,
): { readonly config: ProjectConfig | null; readonly pending: boolean } {
  const hasRoot = project !== null && project.workspaceRoot !== "";
  const session = useEnvironmentQuery(
    hasRoot ? environmentSession.sessionStateAtom(project.environmentId) : null,
  );
  const environment = useEnvironmentPresentation(project?.environmentId ?? null);
  const access = resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
  const canRead = hasRoot && access.canReadFiles;
  const readFile = (relativePath: string) =>
    canRead
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: { cwd: projectConfigRoot(project), relativePath, allowMissing: true },
        })
      : null;
  const styalQuery = useEnvironmentQuery(readFile(STYAL_PROJECT_FILE_NAME));
  const t3Query = useEnvironmentQuery(readFile(T3_PROJECT_FILE_NAME));
  const styal = contentsOf(styalQuery.data as ProjectReadFileResult | null);
  const t3 = contentsOf(t3Query.data as ProjectReadFileResult | null);
  const config = useMemo(() => resolveProjectConfig({ styal, t3 }).config, [styal, t3]);
  const pending =
    (hasRoot && access.isPending) ||
    (styal === null && (styalQuery.isPending || (t3 === null && t3Query.isPending)));
  return { config, pending };
}
