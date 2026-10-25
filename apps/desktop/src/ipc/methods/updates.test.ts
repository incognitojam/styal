import { assert, describe, it } from "@effect/vitest";
import type { HostActivity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopShutdownConfirmation from "../../app/DesktopShutdownConfirmation.ts";
import * as DesktopShutdownGuard from "../../app/DesktopShutdownGuard.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "../../updates/updatesTestHarness.ts";
import { installUpdate } from "./updates.ts";

describe("update installation IPC", () => {
  it.effect.each([
    { name: "explicitly false", input: { expectedVersion: "1.2.4", confirmed: false } },
    { name: "omitted flag", input: { expectedVersion: "1.2.4" } },
    { name: "legacy input", input: undefined },
  ])("reinspects final local work through the native guard for $name", ({ input }) => {
    let activity: HostActivity = {
      activeSessions: 1,
      continuableSessions: 1,
      waitingSessions: 0,
      terminalsRequiringConfirmation: 0,
      terminalsWithUnknownActivity: 0,
      environmentsUsingDevices: 0,
    };
    let reads = 0;
    let prompts = 0;
    let stops = 0;
    const backend: DesktopBackendPool.DesktopBackendInstance = {
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: Effect.succeed("Local host"),
      start: Effect.void,
      stop: () =>
        Effect.sync(() => {
          stops++;
        }),
      waitForReady: () => Effect.succeed(true),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: true,
        activePid: Option.some(100),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      currentConfig: Effect.succeed(
        Option.some({
          executablePath: "/synthetic/electron",
          entryPath: "/synthetic/server.mjs",
          cwd: "/synthetic",
          args: [],
          extendEnv: true,
          bootstrapDelivery: "fd3",
          preflightFailure: Option.none(),
          env: {},
          captureOutput: true,
          httpBaseUrl: new URL("http://127.0.0.1:3773"),
          bootstrap: {
            mode: "desktop",
            noBrowser: true,
            port: 3773,
            t3Home: "/synthetic/state",
            host: "127.0.0.1",
            desktopBootstrapToken: "synthetic-bootstrap",
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          },
        }),
      ),
    };
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.url.endsWith("/oauth/token")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "synthetic-bearer",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "Bearer",
                expires_in: 3600,
                scope: "orchestration:read",
              }),
            );
          }
          reads++;
          return HttpClientResponse.fromWeb(request, Response.json(activity));
        }),
      ),
    );
    const dialog = Layer.succeed(DesktopShutdownConfirmation.DesktopShutdownConfirmation, {
      current: Effect.succeed(null),
      acknowledge: () => Effect.void,
      rendererReady: Effect.void,
      consumeQuitOverride: Effect.succeed(false),
      resolve: () => Effect.void,
      request: () =>
        Effect.sync(() => {
          prompts++;
          return false;
        }),
    });
    const guardLayer = DesktopShutdownGuard.layer.pipe(
      Layer.provide(Layer.mergeAll(DesktopBackendPool.layerTest([backend]), http, dialog)),
    );

    return Effect.gen(function* () {
      const guard = yield* DesktopShutdownGuard.DesktopShutdownGuard;
      const harness = makeHarness({
        backendInstances: [backend],
        confirmShutdown: guard.confirm("restart"),
      });
      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const state = yield* DesktopState.DesktopState;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.equal((yield* guard.inspect)[0]?.terminalsRequiringConfirmation, 0);
        activity = { ...activity, terminalsRequiringConfirmation: 1 };

        assert.deepInclude(yield* installUpdate.handler(input), { accepted: false });
        assert.equal(reads, 2);
        assert.equal(prompts, 1);
        assert.equal(stops, 0);
        assert.isFalse(yield* Ref.get(state.quitting));
        assert.isEmpty(harness.installs);
        assert.equal(harness.installRecords.size, 0);
        assert.equal(harness.updateRestartMarkers.size, 0);
        assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");

        activity = { ...activity, terminalsRequiringConfirmation: 0 };
        assert.deepInclude(yield* installUpdate.handler(input), { accepted: true });
        assert.equal(reads, 3);
        assert.equal(prompts, 1);
        assert.equal(stops, 1);
        assert.isTrue(yield* Ref.get(state.quitting));
        assert.lengthOf(harness.installs, 1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped, Effect.provide(guardLayer));
  });

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

  it.effect("keeps an unconfirmed install guarded and leaves a declined download usable", () => {
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

      assert.deepInclude(yield* installUpdate.handler(undefined), { accepted: false });
      assert.equal(prompts, 1);
      assert.equal(stops, 0);
      assert.isFalse(yield* Ref.get(state.quitting));
      assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
      assert.isEmpty(harness.installs);
      assert.equal(harness.updateRestartMarkers.size, 0);

      confirmed = true;
      assert.deepInclude(yield* installUpdate.handler(undefined), {
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
