import type { EnvironmentId } from "@t3tools/contracts";
import {
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  workspaceFileLookup,
  type WorkspaceEntryCandidate,
} from "@t3tools/client-runtime/workspace-basename-lookup";

import type { MarkdownFileLinkMeta } from "../markdown-links";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useFileMetadataQuery } from "./useFileMetadata";

interface QueryView<A> {
  readonly isSuccess: boolean;
  readonly data: A | null;
}

/** True only once the host and the workspace search both confirm nothing to open. */
export function isMissingFileLink(input: {
  literal: QueryView<unknown>;
  lookup: ReturnType<typeof workspaceFileLookup> | null;
  search: QueryView<{
    entries: ReadonlyArray<WorkspaceEntryCandidate>;
    truncated: boolean;
  }>;
}): boolean {
  if (!input.literal.isSuccess || input.literal.data !== null) return false;
  if (input.lookup === null) return true;
  const result = input.search.data;
  if (!input.search.isSuccess || result === null) return false;
  // A real suffix match ranks inside a full page of fuzzy results. A short
  // truncated page means the index is still scanning, so nothing is ruled out.
  if (result.truncated && result.entries.length < WORKSPACE_BASENAME_LOOKUP_LIMIT) return false;
  return input.lookup.pick(result.entries) === null;
}

export function useMissingFileLink(
  environmentId: EnvironmentId | null,
  meta: MarkdownFileLinkMeta,
  cwd: string | undefined,
): boolean {
  const literal = useFileMetadataQuery(environmentId, meta.filePath);
  const lookup =
    literal.isSuccess && literal.data === null && meta.workspaceLookupPath && cwd
      ? workspaceFileLookup(meta.workspaceLookupPath, cwd)
      : null;
  const search = useEnvironmentQuery(
    environmentId && cwd && lookup
      ? projectEnvironment.searchEntries({
          environmentId,
          input: {
            cwd,
            query: lookup.query,
            limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
            kind: "file",
          },
        })
      : null,
  );
  return isMissingFileLink({ literal, lookup, search });
}
