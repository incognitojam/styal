import { useIsFocused } from "@react-navigation/native";
import {
  advanceSettledShelfFocus,
  type SettledShelfFocus,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useEffect } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";

// Phone thread screens remount per thread, so the last focused thread has to
// outlive them for a move to another thread to be detectable.
let settledShelfFocus: SettledShelfFocus = {
  threadKey: null,
  settled: false,
  latestUserMessageAt: undefined,
};

/**
 * Rendered by the thread screen: collapses the settled shelf once the user
 * moves on from it (see advanceSettledShelfFocus). Kept as its own component
 * so preference updates do not re-render the thread screen.
 */
export function SettledShelfAutoCollapse(props: { readonly thread: EnvironmentThreadShell }) {
  const isFocused = useIsFocused();
  const { settledShelfExpanded, toggleSettledShelf } = useThreadListV2ShelfPreferences();
  const threadKey = scopedThreadKey(props.thread.environmentId, props.thread.id);
  const settled = props.thread.settledOverride === "settled";
  const latestUserMessageAt = props.thread.latestUserMessageAt;

  useEffect(() => {
    if (!isFocused) return;
    const { focus, collapse } = advanceSettledShelfFocus(settledShelfFocus, {
      threadKey,
      settled,
      latestUserMessageAt,
    });
    settledShelfFocus = focus;
    if (collapse && settledShelfExpanded) toggleSettledShelf();
  }, [
    isFocused,
    latestUserMessageAt,
    settled,
    settledShelfExpanded,
    threadKey,
    toggleSettledShelf,
  ]);

  return null;
}
