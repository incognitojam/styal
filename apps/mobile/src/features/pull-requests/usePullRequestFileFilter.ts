import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import { sortReviewParsedDiffByPath, type ReviewParsedDiff } from "../review/reviewModel";
import { useDiffSortMode } from "../review/useDiffSortMode";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { filterPullRequestTestFiles } from "./pullRequestFileFilters";

export function usePullRequestFileFilter(
  parsed: ReviewParsedDiff,
  environmentId: string,
  includePath?: string,
) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const sort = useDiffSortMode({
    view: "pull_request",
    environmentId: EnvironmentId.make(environmentId),
  });
  const hideTestFiles =
    AsyncResult.isSuccess(preferences) && preferences.value.pullRequestHideTestFiles === true;
  const visible = useMemo(() => {
    const filtered = filterPullRequestTestFiles(parsed, hideTestFiles, includePath);
    return sort.sortByRelevance ? filtered : sortReviewParsedDiffByPath(filtered);
  }, [parsed, hideTestFiles, includePath, sort.sortByRelevance]);
  const hiddenCount =
    parsed.kind === "files" && visible.kind === "files" ? parsed.fileCount - visible.fileCount : 0;
  return {
    parsed: visible,
    hideTestFiles,
    hiddenCount,
    sortByRelevance: sort.sortByRelevance,
    toggleSort: sort.toggle,
    toggle: () => savePreferences({ pullRequestHideTestFiles: !hideTestFiles }),
    showAll: () => savePreferences({ pullRequestHideTestFiles: false }),
  };
}
