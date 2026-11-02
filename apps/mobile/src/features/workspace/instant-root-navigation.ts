import { createContext, use } from "react";

/**
 * Runs a root stack change with stack animations off. Android plays the removed top screen's
 * animation, so a tab switch from a Settings page would otherwise slide Home and its bar in.
 */
export const InstantRootNavigationContext = createContext<(navigate: () => void) => void>(
  (navigate) => navigate(),
);

export function useInstantRootNavigation() {
  return use(InstantRootNavigationContext);
}
