import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ComposerDrafts from "./ComposerDrafts.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(
  ComposerDrafts.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

layer("ComposerDraftRepository", (it) => {
  it.effect("uses revision compare-and-swap and preserves the winning snapshot", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 41 });
      const repository = yield* ComposerDrafts.ComposerDraftRepository;
      const threadId = ThreadId.make("draft-cas-thread");
      const common = {
        text: "hello from device one",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      };

      const accepted = yield* repository.update({
        threadId,
        baseRevision: 0,
        common,
        clientMutationId: "device-one-1",
      });
      assert.equal(accepted._tag, "accepted");
      assert.equal(accepted.snapshot.revision, 1);

      const conflict = yield* repository.update({
        threadId,
        baseRevision: 0,
        common: { ...common, text: "stale device" },
        clientMutationId: "device-two-1",
      });
      assert.equal(conflict._tag, "conflict");
      assert.deepEqual(conflict.snapshot.common, common);
      assert.equal(conflict.snapshot.revision, 1);
    }),
  );

  it.effect("keeps clears as revisioned tombstones", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 41 });
      const repository = yield* ComposerDrafts.ComposerDraftRepository;
      const threadId = ThreadId.make("draft-tombstone-thread");

      yield* repository.update({
        threadId,
        baseRevision: 0,
        common: {
          text: "sent later",
          modelSelection: null,
          runtimeMode: null,
          interactionMode: null,
        },
        clientMutationId: "write-1",
      });
      const cleared = yield* repository.update({
        threadId,
        baseRevision: 1,
        common: null,
        clientMutationId: "clear-2",
      });

      assert.equal(cleared._tag, "accepted");
      assert.equal(cleared.snapshot.revision, 2);
      assert.isNull(cleared.snapshot.common);
      assert.deepEqual(yield* repository.get({ threadId }), cleared.snapshot);
    }),
  );

  it.effect("does not let a delayed send clear a newer device revision", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 41 });
      const repository = yield* ComposerDrafts.ComposerDraftRepository;
      const threadId = ThreadId.make("draft-delayed-send-thread");
      const first = {
        text: "message being sent",
        modelSelection: null,
        runtimeMode: null,
        interactionMode: null,
      };
      const newer = { ...first, text: "new text from another device" };

      yield* repository.update({
        threadId,
        baseRevision: 0,
        common: first,
        clientMutationId: "first-device",
      });
      yield* repository.update({
        threadId,
        baseRevision: 1,
        common: newer,
        clientMutationId: "second-device",
      });
      const delayedClear = yield* repository.update({
        threadId,
        baseRevision: 1,
        common: null,
        clientMutationId: "delayed-send",
      });

      assert.equal(delayedClear._tag, "conflict");
      assert.equal(delayedClear.snapshot.revision, 2);
      assert.deepEqual(delayedClear.snapshot.common, newer);
    }),
  );
});
