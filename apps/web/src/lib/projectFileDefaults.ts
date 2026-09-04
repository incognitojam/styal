import {
  STYAL_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { parseStyalProjectFile } from "@t3tools/shared/styalProjectFile";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read `defaultThreadEnvMode` from the checkout's project file.
 *
 * Imperative counterpart to `useProjectFileState` for the new-thread
 * path, which resolves defaults at call time rather than render time. The
 * styal.json owns the checkout whenever it exists. A missing styal.json falls
 * back to t3.json; an invalid one does not. File query atoms cache per
 * (environment, cwd), so repeat calls don't re-fetch.
 */
export async function readProjectFileDefaultThreadEnvMode(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<ThreadEnvMode | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, STYAL_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    STYAL_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data !== null) {
    if (data.truncated) return null;
    return parseStyalProjectFile(data.contents)?.defaultThreadEnvMode ?? null;
  }

  const legacyResult = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const legacyData = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    legacyResult._tag === "Success" ? legacyResult.value : null,
  );
  if (legacyData === null || legacyData.truncated) return null;
  return parseT3ProjectFile(legacyData.contents)?.defaultThreadEnvMode ?? null;
}
