import {
  STYAL_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectConfig,
} from "@t3tools/contracts";
import { resolveProjectConfig } from "@t3tools/shared/projectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

async function readProjectFileContents(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  relativePath: string,
): Promise<string | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, relativePath),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    relativePath,
    result._tag === "Success" ? result.value : null,
  );
  return data === null || data.exists === false || data.truncated ? null : data.contents;
}

/**
 * Imperative counterpart to `useProjectConfigState` for the new-thread path, which resolves
 * defaults at call time. Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders.
 */
export async function readProjectConfig(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<ProjectConfig | null> {
  const [styal, t3] = await Promise.all([
    readProjectFileContents(environmentId, workspaceRoot, STYAL_PROJECT_FILE_NAME),
    readProjectFileContents(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
  ]);
  return resolveProjectConfig({ styal, t3 }).config;
}
