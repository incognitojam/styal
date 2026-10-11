import {
  ThreadId,
  type ComposerDraftCommon,
  type ComposerDraftSnapshot,
  type ComposerDraftUpdateResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  createComposerDraftSyncController,
  createComposerDraftSyncControllerPool,
} from "./composerDrafts.ts";

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

  it("clears a sent draft received after reopening the thread", async () => {
    let local: ComposerDraftCommon | null = null;
    const writes: Array<{ baseRevision: number; common: ComposerDraftCommon | null }> = [];
    const scheduler = makeScheduler();
    const controller = createComposerDraftSyncController({
      threadId: THREAD_ID,
      readLocal: () => local,
      canApplyRemote: () => true,
      shouldIgnoreRemote: (value) => value.common?.text === LOCAL.text,
      applyRemote: (value) => {
        local = value;
      },
      update: async (input) => {
        writes.push({ baseRevision: input.baseRevision, common: input.common });
        return { _tag: "accepted", snapshot: snapshot(3, input.common, input.clientMutationId) };
      },
      createMutationId: () => "clear-after-reopen",
      scheduleTask: scheduler.scheduleTask,
    });

    // A pending autosave landed after Send, and the thread was closed before its clear synced.
    controller.observeSnapshot(snapshot(2, LOCAL));
    expect(local).toBeNull();
    await scheduler.run();
    expect(writes).toEqual([{ baseRevision: 2, common: null }]);

    // Later edits from another device still reach an otherwise clean composer.
    controller.observeSnapshot(snapshot(4, REMOTE));
    expect(local).toEqual(REMOTE);
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

describe("composer draft sync controller pool", () => {
  function setup(initial: ComposerDraftCommon | null = null) {
    let local = initial;
    let server = snapshot(1, initial);
    const writes: Array<{ baseRevision: number; common: ComposerDraftCommon | null }> = [];
    const scheduler = makeScheduler();
    const pool = createComposerDraftSyncControllerPool();
    const options = {
      threadId: THREAD_ID,
      readLocal: () => local,
      canApplyRemote: () => true,
      applyRemote: (common: ComposerDraftCommon | null) => {
        local = common;
      },
      update: async (input: {
        baseRevision: number;
        common: ComposerDraftCommon | null;
        clientMutationId: string;
      }) => {
        writes.push({ baseRevision: input.baseRevision, common: input.common });
        server = snapshot(input.baseRevision + 1, input.common, input.clientMutationId);
        return { _tag: "accepted", snapshot: server } as const;
      },
      createMutationId: () => `mutation-${writes.length + 1}`,
      scheduleTask: scheduler.scheduleTask,
    };
    return {
      pool,
      scheduler,
      options,
      writes,
      readLocal: () => local,
      edit: (common: ComposerDraftCommon | null) => {
        local = common;
      },
      server: () => server,
    };
  }

  it("flushes a live clear on navigation and rejects stale snapshots after reopening", async () => {
    const test = setup(REMOTE);
    const stale = test.server();
    const controller = test.pool.acquire("environment-1/thread-1", test.options);
    controller.observeSnapshot(stale);
    test.edit(null);
    test.pool.release("environment-1/thread-1", controller);
    expect(test.writes).toEqual([{ baseRevision: 1, common: null }]);
    await test.scheduler.run();
    expect(test.server().common).toBeNull();
    expect(test.scheduler.hasTask()).toBe(false);

    const reopened = test.pool.acquire("environment-1/thread-1", test.options);
    reopened.observeSnapshot(stale);
    expect(test.readLocal()).toBeNull();
    reopened.observeSnapshot(test.server());
    reopened.observeSnapshot(snapshot(3, LOCAL));
    expect(test.readLocal()).toEqual(LOCAL);
    test.pool.release("environment-1/thread-1", reopened);
    await test.scheduler.run();
    expect(test.writes).toHaveLength(1);
    expect(test.scheduler.hasTask()).toBe(false);
  });

  it("preserves a clear made before the first subscription snapshot", async () => {
    const test = setup(REMOTE);
    const controller = test.pool.acquire("environment-1/thread-1", test.options);
    test.edit(null);
    test.pool.release("environment-1/thread-1", controller);
    const reopened = test.pool.acquire("environment-1/thread-1", test.options);
    reopened.observeSnapshot(test.server());
    expect(test.readLocal()).toBeNull();
    await test.scheduler.run();
    expect(test.server().common).toBeNull();
  });

  it("saves the latest edit after an older save finishes while the composer is closed", async () => {
    const test = setup(REMOTE);
    const pending = Promise.withResolvers<ComposerDraftUpdateResult>();
    let writeCount = 0;
    const options = {
      ...test.options,
      createMutationId: () => `mutation-${writeCount + 1}`,
      update: (input: Parameters<typeof test.options.update>[0]) => {
        if (writeCount++ === 0) return pending.promise;
        return test.options.update(input);
      },
    };
    const controller = test.pool.acquire("environment-1/thread-1", options);
    controller.observeSnapshot(test.server());
    test.edit(LOCAL);
    controller.observeLocalChange();
    await test.scheduler.run();
    test.edit(null);
    test.pool.release("environment-1/thread-1", controller);
    pending.resolve({ _tag: "accepted", snapshot: snapshot(2, LOCAL, "mutation-1") });
    await test.scheduler.run();
    await test.scheduler.run();
    expect(test.writes).toEqual([{ baseRevision: 2, common: null }]);
    expect(controller.revision()).toBe(3);
    expect(test.readLocal()).toBeNull();
    expect(test.scheduler.hasTask()).toBe(false);
  });

  it("preserves an untouched local cache across navigation and uploads only active edits", async () => {
    const test = setup(LOCAL);
    const controller = test.pool.acquire("environment-1/thread-1", test.options);
    const remote = snapshot(2, REMOTE);
    controller.observeSnapshot(remote);
    test.pool.release("environment-1/thread-1", controller);
    await test.scheduler.run();
    expect(test.readLocal()).toEqual(LOCAL);
    expect(test.writes).toEqual([]);
    expect(test.scheduler.hasTask()).toBe(false);

    const reopened = test.pool.acquire("environment-1/thread-1", test.options);
    reopened.observeSnapshot(remote);
    expect(test.readLocal()).toEqual(LOCAL);
    const edited = { ...LOCAL, text: "actively edited" };
    test.edit(edited);
    reopened.observeLocalChange();
    await test.scheduler.run();
    expect(test.writes).toEqual([{ baseRevision: 2, common: edited }]);
  });
});
