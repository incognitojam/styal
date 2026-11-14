import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** One device-wide choice between relevance and path order, like web's diff sort toggle. */
export function useDiffSortMode() {
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
    },
  };
}
