import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { reportForkClientUsage } from "../../state/forkClientUsage";

/** One device-wide choice between relevance and path order, like web's diff sort toggle. */
export function useDiffSortMode(input: {
  readonly view: "changes" | "pull_request";
  readonly environmentId: EnvironmentId | null | undefined;
}) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const sortByRelevance = !(
    AsyncResult.isSuccess(preferences) && preferences.value.diffSortMode === "alphabetical"
  );
  return {
    sortByRelevance,
    toggle: () => {
      const relevance = !sortByRelevance;
      savePreferences({ diffSortMode: relevance ? "relevance" : "alphabetical" });
      reportForkClientUsage(input.environmentId, {
        feature: "diff-file-review-order",
        action: relevance ? "relevance_selected" : "alphabetical_selected",
        view: input.view,
      });
    },
  };
}
