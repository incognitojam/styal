import {
  STYAL_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectConfig,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { resolveProjectConfig } from "@t3tools/shared/projectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface ProjectConfigState {
  /**
   * - `partial`: the file in effect decoded after invalid or unknown values were ignored.
   * - `invalid`: it is malformed or its root is not an object.
   * - `missing`: neither styal.json nor t3.json is readable at the root.
   */
  status: "loading" | "missing" | "invalid" | "partial" | "valid";
  /** The file the configuration came from; null while loading or missing. */
  source: ProjectConfig["source"] | null;
  /** The resolved configuration when status is `valid` or `partial`. */
  config: ProjectConfig | null;
  /** A legacy t3.json's scripts, which styal never runs but offers to import. */
  legacyScripts: ReadonlyArray<T3ProjectFileScript>;
  /** A legacy t3.json's raw contents while it is the file in effect, for migrating it. */
  legacyContents: string | null;
}

const contentsOf = (query: ReturnType<typeof useProjectFileQuery>) =>
  query.data && !query.data.truncated ? query.data.contents : null;

/**
 * Resolved project configuration for a checkout: `styal.json`, or a legacy
 * `t3.json` when there is none, including whether the file was partially
 * recovered or could not be parsed.
 */
export function useProjectConfigState(
  environmentId: EnvironmentId,
  cwd: string | null,
): ProjectConfigState {
  const styalQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    STYAL_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const t3Query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, cwd !== null);
  const styal = contentsOf(styalQuery);
  const t3 = contentsOf(t3Query);
  // Cached contents count while a refresh is pending. Without styal.json
  // contents, wait for its read to settle before falling back to t3.json, so
  // a legacy file never shows ahead of the file that replaces it.
  const isPending = styal === null && (styalQuery.isPending || (t3 === null && t3Query.isPending));
  if (isPending) {
    return {
      status: "loading",
      source: null,
      config: null,
      legacyScripts: NO_SCRIPTS,
      legacyContents: null,
    };
  }
  const state = resolveProjectConfig({ styal, t3 });
  return {
    status: state.status,
    source: state.status === "missing" ? null : state.source,
    config: state.config,
    legacyScripts: state.legacyScripts.length === 0 ? NO_SCRIPTS : state.legacyScripts,
    legacyContents: state.status !== "missing" && state.source === "t3.json" ? t3 : null,
  };
}

/**
 * Scripts declared in a legacy t3.json, offered in the actions menu for
 * import. Empty once the project has a styal.json, and for missing or
 * invalid files. Invalid entries are omitted without hiding valid siblings.
 */
export function useLegacyProjectScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useProjectConfigState(environmentId, cwd).legacyScripts;
}

/**
 * The directory a project's shared configuration is read from: the
 * registered project root, never a thread's worktree, so every thread of the
 * project sees the same file actions. The one place to change that source.
 */
export function projectConfigRoot(project: { readonly workspaceRoot: string }): string {
  return project.workspaceRoot;
}

/** The project's shared configuration, read from {@link projectConfigRoot}. */
export function useProjectRootConfig(
  project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string } | null,
): ProjectConfig | null {
  return useProjectConfigState(
    project?.environmentId ?? ("" as EnvironmentId),
    project && project.workspaceRoot !== "" ? projectConfigRoot(project) : null,
  ).config;
}
