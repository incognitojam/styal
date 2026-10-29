import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "../../updates/updatesTestHarness.ts";
import { installUpdate } from "./updates.ts";

describe("update installation IPC", () => {
  it.effect("installs the version confirmed by the aggregate dialog without another prompt", () => {
    let prompts = 0;
    let stops = 0;
    const harness = makeHarness({
      confirmShutdown: Effect.sync(() => {
        prompts += 1;
        return false;
      }),
      stopBackend: Effect.sync(() => {
        stops += 1;
      }),
    });

    return Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      const state = yield* DesktopState.DesktopState;
      yield* updates.configure;
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;

      const result = yield* installUpdate.handler({ expectedVersion: "1.2.4", confirmed: true });

      assert.deepInclude(result, { accepted: true, completed: false });
      assert.equal(prompts, 0);
      assert.equal(stops, 1);
      assert.isTrue(yield* Ref.get(state.quitting));
      assert.deepEqual(harness.installs, [{ isSilent: true, isForceRunAfter: true }]);
      assert.deepEqual(
        [...harness.installRecords.values()].map((record) => JSON.parse(record)),
        [{ fromVersion: "1.2.3", targetVersion: "1.2.4" }],
      );
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect.each([
    { name: "without a version", input: undefined },
    { name: "for a pinned version without consent", input: { expectedVersion: "1.2.4" } },
  ])("asks before an install $name and leaves a declined download usable", ({ input }) => {
    let confirmed = false;
    let prompts = 0;
    let stops = 0;
    const harness = makeHarness({
      confirmShutdown: Effect.sync(() => {
        prompts += 1;
        return confirmed;
      }),
      stopBackend: Effect.sync(() => {
        stops += 1;
      }),
    });

    return Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      const state = yield* DesktopState.DesktopState;
      yield* updates.configure;
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;

      assert.deepInclude(yield* installUpdate.handler(input), { accepted: false });
      assert.equal(prompts, 1);
      assert.equal(stops, 0);
      assert.isFalse(yield* Ref.get(state.quitting));
      assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
      assert.isEmpty(harness.installs);
      assert.equal(harness.updateRestartMarkers.size, 0);

      confirmed = true;
      assert.deepInclude(yield* installUpdate.handler(input), {
        accepted: true,
        completed: false,
      });
      assert.equal(prompts, 2);
      assert.equal(stops, 1);
      assert.lengthOf(harness.installs, 1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect.each([false, true])(
    "refuses a stale version even with confirmed=%s and permits the matching version",
    (confirmed) => {
      let stops = 0;
      let prompts = 0;
      const harness = makeHarness({
        confirmShutdown: Effect.sync(() => {
          prompts += 1;
          return false;
        }),
        stopBackend: Effect.sync(() => {
          stops += 1;
        }),
      });

      return Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const state = yield* DesktopState.DesktopState;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;

        const stale = yield* installUpdate.handler({ expectedVersion: "1.2.4", confirmed });

        assert.deepInclude(stale, { accepted: false, completed: false });
        assert.equal(stops, 0);
        assert.equal(prompts, 0);
        assert.isFalse(yield* Ref.get(state.quitting));
        assert.equal((yield* updates.getState).downloadedVersion, "1.2.5");
        assert.isEmpty(harness.installs);
        assert.equal(harness.installRecords.size, 0);
        assert.equal(harness.updateRestartMarkers.size, 0);

        assert.deepInclude(
          yield* installUpdate.handler({ expectedVersion: "1.2.5", confirmed: true }),
          {
            accepted: true,
            completed: false,
          },
        );
        assert.equal(stops, 1);
        assert.lengthOf(harness.installs, 1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );
});
