import {
  type ComposerDraftCommon,
  type ComposerDraftSnapshot,
  type ComposerDraftUpdateResult,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Typed RPC primitives used by the web composer adapter and desktop wrapper. */
export function createComposerDraftEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:composer-draft:changes",
      tag: WS_METHODS.subscribeComposerDraft,
      idleTtlMs: 1_000,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:composer-draft:update",
      tag: WS_METHODS.composerDraftUpdate,
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}

export function canonicalComposerDraftCommon(
  common: ComposerDraftCommon | null,
): ComposerDraftCommon | null {
  if (
    common === null ||
    (common.text.length === 0 &&
      common.modelSelection === null &&
      common.runtimeMode === null &&
      common.interactionMode === null)
  ) {
    return null;
  }
  return common;
}

export function composerDraftCommonEquals(
  left: ComposerDraftCommon | null,
  right: ComposerDraftCommon | null,
): boolean {
  return (
    JSON.stringify(canonicalComposerDraftCommon(left)) ===
    JSON.stringify(canonicalComposerDraftCommon(right))
  );
}

export interface ComposerDraftSyncController {
  readonly observeSnapshot: (snapshot: ComposerDraftSnapshot) => void;
  readonly observeLocalChange: () => void;
  readonly revision: () => number;
  readonly dispose: () => void;
}

/**
 * Reconciles one existing thread's local cache with its revisioned server value.
 * The surface owns persistence and rendering; this controller only defines the
 * conflict and debounce behavior shared by web and desktop.
 */
export function createComposerDraftSyncController(options: {
  readonly threadId: ThreadId;
  readonly readLocal: () => ComposerDraftCommon | null;
  readonly canApplyRemote: () => boolean;
  readonly applyRemote: (common: ComposerDraftCommon | null) => void;
  readonly update: (input: {
    readonly threadId: ThreadId;
    readonly baseRevision: number;
    readonly common: ComposerDraftCommon | null;
    readonly clientMutationId: string;
  }) => Promise<ComposerDraftUpdateResult | null>;
  readonly createMutationId: () => string;
  readonly scheduleTask: (task: () => void, delayMs: number) => () => void;
  readonly onRevisionChange?: (snapshot: ComposerDraftSnapshot) => void;
  readonly debounceMs?: number;
}): ComposerDraftSyncController {
  const debounceMs = options.debounceMs ?? 1_200;
  let disposed = false;
  let initialized = false;
  let currentRevision = 0;
  let lastSynced: ComposerDraftCommon | null = null;
  let cancelScheduledTask: (() => void) | null = null;
  let inFlight = false;
  let pendingAfterFlight = false;

  const cancelTimer = () => {
    if (cancelScheduledTask !== null) {
      cancelScheduledTask();
      cancelScheduledTask = null;
    }
  };

  const schedule = (delay = debounceMs) => {
    if (disposed || !initialized) return;
    cancelTimer();
    cancelScheduledTask = options.scheduleTask(() => {
      cancelScheduledTask = null;
      void flush();
    }, delay);
  };

  const acceptSnapshotMetadata = (snapshot: ComposerDraftSnapshot) => {
    currentRevision = snapshot.revision;
    lastSynced = canonicalComposerDraftCommon(snapshot.common);
    options.onRevisionChange?.(snapshot);
  };

  const flush = async () => {
    if (disposed || !initialized) return;
    if (inFlight) {
      pendingAfterFlight = true;
      return;
    }
    const sent = canonicalComposerDraftCommon(options.readLocal());
    if (composerDraftCommonEquals(sent, lastSynced)) return;

    const baseRevision = currentRevision;
    const clientMutationId = options.createMutationId();
    inFlight = true;
    const result = await options.update({
      threadId: options.threadId,
      baseRevision,
      common: sent,
      clientMutationId,
    });
    inFlight = false;
    if (disposed) return;

    if (result === null) {
      // The subscription/reconnect path will call observeLocalChange again.
      return;
    }

    acceptSnapshotMetadata(result.snapshot);
    const localNow = canonicalComposerDraftCommon(options.readLocal());
    if (result._tag === "conflict") {
      // An actively edited local value wins by retrying against the new base.
      if (composerDraftCommonEquals(localNow, sent)) schedule(0);
      else schedule();
    } else if (!composerDraftCommonEquals(localNow, lastSynced)) {
      schedule();
    }

    if (pendingAfterFlight) {
      pendingAfterFlight = false;
      if (!composerDraftCommonEquals(options.readLocal(), lastSynced)) schedule();
    }
  };

  const observeSnapshot = (snapshot: ComposerDraftSnapshot) => {
    if (disposed || snapshot.threadId !== options.threadId || snapshot.revision < currentRevision) {
      return;
    }
    const remote = canonicalComposerDraftCommon(snapshot.common);
    const local = canonicalComposerDraftCommon(options.readLocal());

    if (!initialized) {
      initialized = true;
      acceptSnapshotMetadata(snapshot);
      if (snapshot.revision === 0) {
        if (!composerDraftCommonEquals(local, remote)) schedule();
        return;
      }
      if (!options.canApplyRemote()) {
        // Hide a transferable draft as soon as this web/desktop client has
        // richer local context; another client must not send an incomplete copy.
        if (remote !== null) schedule();
        return;
      }
      if (local === null || composerDraftCommonEquals(local, remote)) {
        if (!composerDraftCommonEquals(local, remote)) options.applyRemote(remote);
      }
      // Preserve a non-empty local cache on first contact. It is uploaded only
      // after the user edits it, avoiding an automatic migration-time overwrite.
      return;
    }

    if (snapshot.revision === currentRevision && composerDraftCommonEquals(remote, lastSynced)) {
      return;
    }

    const wasClean = composerDraftCommonEquals(local, lastSynced);
    acceptSnapshotMetadata(snapshot);
    if (wasClean && options.canApplyRemote()) {
      options.applyRemote(remote);
      return;
    }
    // Local typing (or a client-local attachment) wins after the idle window.
    schedule();
  };

  return {
    observeSnapshot,
    observeLocalChange: () => {
      if (!initialized || disposed) return;
      if (composerDraftCommonEquals(options.readLocal(), lastSynced)) cancelTimer();
      else schedule();
    },
    revision: () => currentRevision,
    dispose: () => {
      disposed = true;
      cancelTimer();
    },
  };
}
