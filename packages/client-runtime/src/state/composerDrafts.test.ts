import { ThreadId, type ComposerDraftCommon, type ComposerDraftSnapshot } from "@t3tools/contracts";
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
