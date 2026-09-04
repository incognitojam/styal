import {
  STYAL_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectScript,
  type StyalProjectFile,
} from "@t3tools/contracts";
import { projectScriptsFromStyalFile } from "@t3tools/shared/projectScripts";
import { parseStyalProjectFile } from "@t3tools/shared/styalProjectFile";
import { useMemo } from "react";

import {
  isProjectFileNotFoundFailure,
  useProjectFileQuery,
} from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<ProjectScript> = [];

export interface StyalProjectFileState {
  /**
   * - `valid`: styal.json exists and decoded.
   * - `invalid`: styal.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable styal.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: StyalProjectFile | null;
  /** Original JSONC text, retained so action edits can preserve unrelated fields and comments. */
  contents: string | null;
  scripts: ReadonlyArray<ProjectScript>;
  refresh: () => void;
}

/**
 * Decoded state of the project's checked-in `styal.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useStyalProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): StyalProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    STYAL_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const missing = isProjectFileNotFoundFailure(query.failure);
  const unavailable = query.data?.truncated === true || (query.error !== null && !missing);
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : unavailable ? "invalid" : "missing",
        file: null,
        contents: null,
        scripts: NO_SCRIPTS,
        refresh: query.refresh,
      } as const;
    }
    const file = parseStyalProjectFile(contents);
    if (file === null) {
      return {
        status: "invalid",
        file: null,
        contents,
        scripts: NO_SCRIPTS,
        refresh: query.refresh,
      } as const;
    }
    return {
      status: "valid",
      file,
      contents,
      scripts: projectScriptsFromStyalFile(file.scripts ?? []),
      refresh: query.refresh,
    } as const;
  }, [contents, isPending, missing, query.refresh, unavailable]);
}

/**
 * Runnable scripts declared in the project's checked-in `styal.json`. Missing,
 * truncated, or invalid files resolve to an empty list.
 */
export function useStyalProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<ProjectScript> {
  return useStyalProjectFileState(environmentId, cwd).scripts;
}
