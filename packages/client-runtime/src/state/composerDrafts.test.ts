import {
  ThreadId,
  type ComposerDraftCommon,
  type ComposerDraftSnapshot,
  type ComposerDraftUpdateResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { createComposerDraftSyncController } from "./composerDrafts.ts";

const THREAD_ID = ThreadId.make("thread-1");
const REMOTE: ComposerDraftCommon = {
  text: "from server",
  modelSelection: null,
  runtimeMode: null,
  interactionMode: null,
};
const LOCAL: ComposerDraftCommon = {
  text: "local edit",
  modelSelection: null,
  runtimeMode: null,
  interactionMode: null,
};

function snapshot(
  revision: number,
  common: ComposerDraftCommon | null,
  clientMutationId = "server-change",
): ComposerDraftSnapshot {
  return {
    threadId: THREAD_ID,
    revision,
    common,
    updatedAt: "2026-08-08T12:00:00.000Z",
    clientMutationId,
  };
}

function makeScheduler() {
  let scheduled: (() => void) | null = null;
  return {
    scheduleTask: (task: () => void) => {
      scheduled = task;
      return () => {
        if (scheduled === task) scheduled = null;
      };
    },
    run: async () => {
      const task = scheduled;
      scheduled = null;
      task?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    hasTask: () => scheduled !== null,
  };
}

describe("composer draft sync controller", () => {
  it.each([
    { change: "edit", common: REMOTE },
    { change: "clear", common: null },
  ])("applies a remote $change between our save echo and response", async ({ common }) => {
    let local: ComposerDraftCommon | null = null;
    const writes: Array<ComposerDraftCommon | null> = [];
    const revisions: number[] = [];
    const scheduler = makeScheduler();
    const autosave = Promise.withResolvers<ComposerDraftUpdateResult>();
    const controller = createComposerDraftSyncController({
      threadId: THREAD_ID,
      readLocal: () => local,
      canApplyRemote: () => true,
      applyRemote: (value) => {
        local = value;
      },
      update: async (input) => {
        writes.push(input.common);
        if (writes.length === 1) return autosave.promise;
        return { _tag: "accepted", snapshot: snapshot(3, input.common, input.clientMutationId) };
      },
      createMutationId: () => `mutation-${writes.length + 1}`,
      scheduleTask: scheduler.scheduleTask,
      onRevisionChange: (value) => revisions.push(value.revision),
    });

    controller.observeSnapshot(snapshot(0, null));
    local = LOCAL;
    controller.observeLocalChange();
    await scheduler.run();
    const saved = snapshot(1, LOCAL, "mutation-1");
    controller.observeSnapshot(saved);
    controller.observeSnapshot(snapshot(2, common));

    expect(local).toEqual(common);
    autosave.resolve({ _tag: "accepted", snapshot: saved });
    await scheduler.run();
    await scheduler.run();

    expect(local).toEqual(common);
    expect(controller.revision()).toBe(2);
    expect(revisions).toEqual([0, 1, 2]);
    expect(writes).toEqual([LOCAL]);
    expect(scheduler.hasTask()).toBe(false);
  });

  it.each(["subscription-first", "response-first", "after-transport-failure"])(
    "keeps a sent composer empty when its pending autosave arrives %s",
    async (order) => {
      let local: ComposerDraftCommon | null = null;
      const writes: Array<{ baseRevision: number; common: ComposerDraftCommon | null }> = [];
      const scheduler = makeScheduler();
      const autosave = Promise.withResolvers<ComposerDraftUpdateResult | null>();
      const controller = createComposerDraftSyncController({
        threadId: THREAD_ID,
        readLocal: () => local,
        canApplyRemote: () => true,
        applyRemote: (common) => {
          local = common;
        },
        update: async (input) => {
          writes.push({ baseRevision: input.baseRevision, common: input.common });
          if (writes.length === 1) return autosave.promise;
          return { _tag: "accepted", snapshot: snapshot(2, input.common, input.clientMutationId) };
        },
        createMutationId: () => `mutation-${writes.length + 1}`,
        scheduleTask: scheduler.scheduleTask,
      });

      controller.observeSnapshot(snapshot(0, null));
      local = LOCAL;
      controller.observeLocalChange();
      await scheduler.run();

      // Sending clears the composer before the pending draft save is acknowledged.
      local = null;
      controller.observeLocalChange();
      const saved = snapshot(1, LOCAL, "mutation-1");
      if (order === "subscription-first") controller.observeSnapshot(saved);
      autosave.resolve(
        order === "after-transport-failure" ? null : { _tag: "accepted", snapshot: saved },
      );
      await scheduler.run();
      if (order !== "subscription-first") controller.observeSnapshot(saved);

      expect(local).toBeNull();
      await scheduler.run();
      expect(writes).toEqual([
        { baseRevision: 0, common: LOCAL },
        { baseRevision: 1, common: null },
      ]);
      expect(controller.revision()).toBe(2);

      // Once the clear is synchronized, drafts from another device still arrive.
      controller.observeSnapshot(snapshot(3, REMOTE));
      expect(local).toEqual(REMOTE);
      expect(scheduler.hasTask()).toBe(false);
    },
  );

  it("applies an authoritative remote draft when the local cache is empty", () => {
    let local: ComposerDraftCommon | null = null;
    const scheduler = makeScheduler();
    const controller = createComposerDraftSyncController({
      threadId: THREAD_ID,
      readLocal: () => local,
      canApplyRemote: () => true,
      applyRemote: (common) => {
        local = common;
      },
      update: async () => null,
      createMutationId: () => "mutation-1",
      scheduleTask: scheduler.scheduleTask,
    });

    controller.observeSnapshot(snapshot(1, REMOTE));

    expect(local).toEqual(REMOTE);
    expect(controller.revision()).toBe(1);
    expect(scheduler.hasTask()).toBe(false);
  });

  it("does not overwrite a non-empty local cache on first contact", async () => {
    let local: ComposerDraftCommon | null = LOCAL;
    const writes: Array<{ baseRevision: number; common: ComposerDraftCommon | null }> = [];
    const scheduler = makeScheduler();
    const controller = createComposerDraftSyncController({
      threadId: THREAD_ID,
      readLocal: () => local,
      canApplyRemote: () => true,
      applyRemote: (common) => {
        local = common;
      },
      update: async (input) => {
        writes.push({ baseRevision: input.baseRevision, common: input.common });
        return { _tag: "accepted", snapshot: snapshot(2, input.common, input.clientMutationId) };
      },
      createMutationId: () => "mutation-1",
      scheduleTask: scheduler.scheduleTask,
    });

    controller.observeSnapshot(snapshot(1, REMOTE));
    expect(local).toEqual(LOCAL);
    expect(scheduler.hasTask()).toBe(false);

    local = { ...LOCAL, text: "actively edited" };
    controller.observeLocalChange();
    await scheduler.run();

    expect(writes).toEqual([{ baseRevision: 1, common: local }]);
  });

  it("retries an active local edit against the revision returned by a conflict", async () => {
    let local: ComposerDraftCommon | null = null;
    const bases: number[] = [];
    const scheduler = makeScheduler();
    const controller = createComposerDraftSyncController({
      threadId: THREAD_ID,
      readLocal: () => local,
      canApplyRemote: () => true,
      applyRemote: (common) => {
        local = common;
      },
      update: async (input) => {
        bases.push(input.baseRevision);
        return bases.length === 1
          ? { _tag: "conflict", snapshot: snapshot(2, REMOTE) }
          : { _tag: "accepted", snapshot: snapshot(3, input.common, input.clientMutationId) };
      },
      createMutationId: () => `mutation-${bases.length + 1}`,
      scheduleTask: scheduler.scheduleTask,
    });

    controller.observeSnapshot(snapshot(0, null));
    local = LOCAL;
    controller.observeLocalChange();
    await scheduler.run();
    await scheduler.run();

    expect(bases).toEqual([0, 2]);
    expect(controller.revision()).toBe(3);
    expect(local).toEqual(LOCAL);
  });

  it("tombstones the transferable copy while device-only context is present", async () => {
    const writes: Array<ComposerDraftCommon | null> = [];
    const scheduler = makeScheduler();
    const controller = createComposerDraftSyncController({
      threadId: THREAD_ID,
      readLocal: () => null,
      canApplyRemote: () => false,
      applyRemote: () => {
        throw new Error("remote state must not replace device-only context");
      },
      update: async (input) => {
        writes.push(input.common);
        return { _tag: "accepted", snapshot: snapshot(2, null, input.clientMutationId) };
      },
      createMutationId: () => "context-tombstone",
      scheduleTask: scheduler.scheduleTask,
    });

    controller.observeSnapshot(snapshot(1, REMOTE));
    await scheduler.run();

    expect(writes).toEqual([null]);
  });
});
