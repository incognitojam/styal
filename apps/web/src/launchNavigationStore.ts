import { EARLY_LOAD_GRACE } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { create } from "zustand";

export type LaunchNavigationOwner = "index-draft" | "server-bootstrap";

export type BootstrapLaunchDecision =
  | { readonly type: "ignore" }
  | { readonly type: "mark-handled"; readonly bootstrapKey: string }
  | { readonly type: "navigate"; readonly bootstrapKey: string };

interface LaunchNavigationState {
  readonly owner: LaunchNavigationOwner | null;
  readonly handledBootstrapKey: string | null;
  /**
   * True until this page load's first launch navigation resolves: a welcome, a claim, the
   * deadline, or the page showing any route but Home. It never returns.
   */
  readonly launchPending: boolean;
  readonly claim: (owner: LaunchNavigationOwner) => boolean;
  readonly release: (owner: LaunchNavigationOwner) => void;
  readonly markBootstrapHandled: (bootstrapKey: string) => void;
  readonly settleLaunch: () => void;
  /** Starts the launch's one welcome deadline; later calls keep the first. */
  readonly awaitLaunchWelcome: () => void;
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

/**
 * Server rows can arrive before the welcome that names the bootstrap thread, so a launch whose
 * primary shell did not start from the persisted cache holds a primary project until the welcome
 * or the deadline. Other environments' projects start the draft at once.
 */
export function isLaunchWelcomeAwaited(input: {
  readonly launchPending: boolean;
  readonly welcome: ServerLifecycleWelcomePayload | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly primaryShellRestoredFromCache: boolean;
  readonly project: { readonly environmentId: EnvironmentId } | null;
}): boolean {
  return (
    input.launchPending &&
    input.welcome === null &&
    input.project !== null &&
    input.project.environmentId === input.primaryEnvironmentId &&
    !input.primaryShellRestoredFromCache
  );
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

export const useLaunchNavigationStore = create<LaunchNavigationState>()((set, get) => {
  let welcomeDeadline: ReturnType<typeof setTimeout> | undefined;
  const settleLaunch = () => {
    clearTimeout(welcomeDeadline);
    welcomeDeadline = undefined;
    if (get().launchPending) set({ launchPending: false });
  };
  return {
    owner: null,
    handledBootstrapKey: null,
    launchPending: true,
    claim: (owner) => {
      if (get().owner !== null) {
        return false;
      }
      set({ owner });
      settleLaunch();
      return true;
    },
    release: (owner) => {
      if (get().owner === owner) {
        set({ owner: null });
      }
    },
    markBootstrapHandled: (handledBootstrapKey) => set({ handledBootstrapKey }),
    settleLaunch,
    awaitLaunchWelcome: () => {
      if (get().launchPending && welcomeDeadline === undefined) {
        welcomeDeadline = setTimeout(settleLaunch, Duration.toMillis(EARLY_LOAD_GRACE));
      }
    },
  };
});
