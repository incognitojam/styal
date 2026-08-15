import type { ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import { create } from "zustand";

type LaunchNavigationOwner = "index-draft" | "server-bootstrap";

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
