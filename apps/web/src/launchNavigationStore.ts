import type { ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import { create } from "zustand";

export type LaunchNavigationOwner = "index-draft" | "server-bootstrap";

export type BootstrapLaunchDecision =
  | { readonly type: "ignore" }
  | { readonly type: "mark-handled"; readonly bootstrapKey: string }
  | { readonly type: "navigate"; readonly bootstrapKey: string };

interface LaunchNavigationState {
  readonly owner: LaunchNavigationOwner | null;
  readonly handledBootstrapKey: string | null;
  readonly claim: (owner: LaunchNavigationOwner) => boolean;
  readonly release: (owner: LaunchNavigationOwner) => void;
  readonly markBootstrapHandled: (bootstrapKey: string) => void;
}

export function bootstrapWelcomeKey(welcome: ServerLifecycleWelcomePayload | null): string | null {
  if (!welcome?.bootstrapProjectId || !welcome.bootstrapThreadId) {
    return null;
  }
  return `${welcome.environment.environmentId}\0${welcome.bootstrapThreadId}`;
}

export function isBootstrapWelcomePending(
  welcome: ServerLifecycleWelcomePayload | null,
  handledBootstrapKey: string | null,
): boolean {
  const key = bootstrapWelcomeKey(welcome);
  return key !== null && key !== handledBootstrapKey;
}

export function decideBootstrapLaunch(input: {
  readonly welcome: ServerLifecycleWelcomePayload | null;
  readonly handledBootstrapKey: string | null;
  readonly pathname: string;
  readonly owner: LaunchNavigationOwner | null;
}): BootstrapLaunchDecision {
  const bootstrapKey = bootstrapWelcomeKey(input.welcome);
  if (bootstrapKey === null || bootstrapKey === input.handledBootstrapKey) {
    return { type: "ignore" };
  }
  if (input.pathname !== "/" || input.owner !== null) {
    // autoBootstrapProjectFromCwd publishes a later launch hint separately
    // from the plain welcome. It is intentionally best-effort once cached
    // restoration owns the root: launch context cannot interrupt user input.
    return { type: "mark-handled", bootstrapKey };
  }
  return { type: "navigate", bootstrapKey };
}

/** A null result means another draft operation won an await-time race. */
export function indexDraftStartNeedsRetry(result: unknown): boolean {
  return result === null;
}

export const useLaunchNavigationStore = create<LaunchNavigationState>()((set, get) => ({
  owner: null,
  handledBootstrapKey: null,
  claim: (owner) => {
    if (get().owner !== null) {
      return false;
    }
    set({ owner });
    return true;
  },
  release: (owner) => {
    if (get().owner === owner) {
      set({ owner: null });
    }
  },
  markBootstrapHandled: (handledBootstrapKey) => set({ handledBootstrapKey }),
}));
