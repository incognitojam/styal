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
  readonly flush: () => void;
  readonly hasPendingChanges: () => boolean;
  readonly dispose: () => void;
}

/** Pending writes belong to the thread, including while its composer is closed. */
export function createComposerDraftSyncControllerPool() {
  const entries = new Map<string, { controller: ComposerDraftSyncController; users: number }>();
  // Subscription atoms can briefly replay a cached snapshot after reopening.
  const revisions = new Map<string, number>();
  return {
    acquire: (key: string, options: Parameters<typeof createComposerDraftSyncController>[0]) => {
      const existing = entries.get(key);
      if (existing) {
        existing.users += 1;
        return existing.controller;
      }
      const controller = createComposerDraftSyncController({
        ...options,
        initialRevision: revisions.get(key) ?? 0,
        onRevisionChange: (snapshot) => {
          revisions.set(key, snapshot.revision);
          options.onRevisionChange?.(snapshot);
        },
        onSettled: () => {
          const entry = entries.get(key);
          if (entry?.controller === controller && entry.users === 0) {
            entries.delete(key);
            controller.dispose();
          }
          options.onSettled?.();
        },
      });
      entries.set(key, { controller, users: 1 });
      return controller;
    },
    release: (key: string, controller: ComposerDraftSyncController) => {
      const entry = entries.get(key);
      if (entry?.controller !== controller || entry.users === 0) return;
      entry.users -= 1;
      if (entry.users > 0) return;
      // React may not have rendered the last synchronous store edit before unmounting.
      controller.observeLocalChange();
      if (controller.hasPendingChanges()) controller.flush();
      else {
        entries.delete(key);
        controller.dispose();
      }
    },
  };
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
  readonly shouldIgnoreRemote?: (snapshot: ComposerDraftSnapshot) => boolean;
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
  readonly onSettled?: () => void;
  readonly initialRevision?: number;
  readonly debounceMs?: number;
}): ComposerDraftSyncController {
  const debounceMs = options.debounceMs ?? 1_200;
  let disposed = false;
  let initialized = false;
  let currentRevision = options.initialRevision ?? 0;
  let lastSynced: ComposerDraftCommon | null = null;
  let cancelScheduledTask: (() => void) | null = null;
  let inFlight = false;
  let lastIssuedMutationId: string | null = null;
  let pendingAfterFlight = false;
  let lastObservedLocal = canonicalComposerDraftCommon(options.readLocal());
  let hasLocalEdit = false;

  const hasPendingChanges = () =>
    inFlight ||
    (hasLocalEdit && (!initialized || !composerDraftCommonEquals(options.readLocal(), lastSynced)));
  const settled = () => {
    if (!hasPendingChanges()) options.onSettled?.();
  };

  const cancelTimer = () => {
    if (cancelScheduledTask !== null) {
      cancelScheduledTask();
      cancelScheduledTask = null;
    }
  };

  const schedule = (delay = debounceMs) => {
    if (disposed || !initialized) return;
    hasLocalEdit = true;
    cancelTimer();
    cancelScheduledTask = options.scheduleTask(() => {
      cancelScheduledTask = null;
      void flush();
    }, delay);
  };

  const acceptSnapshotMetadata = (snapshot: ComposerDraftSnapshot) => {
    // The subscription may have already delivered a newer revision than this response.
    if (snapshot.revision < currentRevision) return;
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
    if (composerDraftCommonEquals(sent, lastSynced)) {
      settled();
      return;
    }

    const baseRevision = currentRevision;
    const clientMutationId = options.createMutationId();
    inFlight = true;
    lastIssuedMutationId = clientMutationId;
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
      settled();
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
    settled();
  };

  const observeSnapshot = (snapshot: ComposerDraftSnapshot) => {
    if (disposed || snapshot.threadId !== options.threadId || snapshot.revision < currentRevision) {
      return;
    }
    const remote = canonicalComposerDraftCommon(snapshot.common);
    const local = canonicalComposerDraftCommon(options.readLocal());

    if (!initialized) {
      if (!composerDraftCommonEquals(local, lastObservedLocal)) hasLocalEdit = true;
      initialized = true;
      acceptSnapshotMetadata(snapshot);
      if (hasLocalEdit) {
        if (!composerDraftCommonEquals(local, remote)) schedule();
        else settled();
        return;
      }
      if (snapshot.revision === 0) {
        if (!composerDraftCommonEquals(local, remote)) schedule();
        return;
      }
      if (!options.canApplyRemote() || options.shouldIgnoreRemote?.(snapshot)) {
        // Keep richer local context or a just-sent draft out of the composer,
        // then clear the stale server copy against its latest revision.
        if (remote !== null) schedule();
        return;
      }
      if (local === null || composerDraftCommonEquals(local, remote)) {
        if (!composerDraftCommonEquals(local, remote)) options.applyRemote(remote);
      }
      lastObservedLocal = canonicalComposerDraftCommon(options.readLocal());
      // Preserve a non-empty local cache on first contact. It is uploaded only
      // after the user edits it, avoiding an automatic migration-time overwrite.
      return;
    }

    if (snapshot.revision === currentRevision && composerDraftCommonEquals(remote, lastSynced)) {
      return;
    }

    // Our own save echo acknowledges an earlier local value; applying it could
    // restore text cleared by a send. Other devices can still update a clean draft.
    // Retain the mutation ID after transport failure: the write may have succeeded.
    const wasClean =
      (lastIssuedMutationId === null || snapshot.clientMutationId !== lastIssuedMutationId) &&
      composerDraftCommonEquals(local, lastSynced);
    acceptSnapshotMetadata(snapshot);
    if (wasClean && options.canApplyRemote() && !options.shouldIgnoreRemote?.(snapshot)) {
      options.applyRemote(remote);
      lastObservedLocal = canonicalComposerDraftCommon(options.readLocal());
      settled();
      return;
    }
    // Local typing (or a client-local attachment) wins after the idle window.
    schedule();
  };

  return {
    observeSnapshot,
    observeLocalChange: () => {
      if (disposed) return;
      const local = canonicalComposerDraftCommon(options.readLocal());
      if (!composerDraftCommonEquals(local, lastObservedLocal)) hasLocalEdit = true;
      lastObservedLocal = local;
      if (!initialized) return;
      if (composerDraftCommonEquals(local, lastSynced)) {
        cancelTimer();
        settled();
      } else if (hasLocalEdit) schedule();
    },
    revision: () => currentRevision,
    flush: () => {
      cancelTimer();
      void flush();
    },
    hasPendingChanges,
    dispose: () => {
      disposed = true;
      cancelTimer();
    },
  };
}
