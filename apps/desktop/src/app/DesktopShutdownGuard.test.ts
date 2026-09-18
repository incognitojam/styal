import { assert, describe, it } from "@effect/vitest";
import type { HostActivity } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopShutdownConfirmation from "./DesktopShutdownConfirmation.ts";
import * as Guard from "./DesktopShutdownGuard.ts";

const idle: HostActivity = {
  activeSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
};
function harness(
  options: {
    activity?: (host: string) => Effect.Effect<unknown>;
    dialog?: Effect.Effect<number>;
    stopped?: boolean;
    quitOverride?: boolean;
    status?: number;
  } = {},
) {
  const messages: string[] = [];
  let checks = 0;
  let exchanges = 0;
  let overrideChecks = 0;
  const instances = ["primary", "wsl"].map(
    (id, index): DesktopBackendPool.DesktopBackendInstance => ({
      id: DesktopBackendPool.BackendInstanceId(id),
      label: Effect.succeed(id),
      start: Effect.void,
      stop: () => Effect.void,
      waitForReady: () => Effect.succeed(true),
      snapshot: Effect.succeed({
        desiredRunning: !options.stopped,
        ready: !options.stopped,
        activePid: options.stopped ? Option.none() : Option.some(index + 100),
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
          httpBaseUrl: new URL(`http://127.0.0.1:${3773 + index}`),
          bootstrap: {
            mode: "desktop",
            noBrowser: true,
            port: 3773 + index,
            t3Home: "/synthetic/state",
            host: "127.0.0.1",
            desktopBootstrapToken: "synthetic-bootstrap",
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          },
        }),
      ),
    }),
  );
  const pool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed(instances),
    primary: Effect.succeed(instances[0]!),
    get: () => Effect.succeed(Option.none()),
    register: () => Effect.die("unexpected register"),
    unregister: () => Effect.void,
  });
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const auth = request.url.endsWith("/oauth/token");
        if (auth) exchanges++;
        else checks++;
        const body = auth
          ? {
              access_token: "synthetic-bearer",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "orchestration:read",
            }
          : yield* options.activity?.(new URL(request.url).port) ?? Effect.succeed(idle);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(body, { status: auth ? 200 : (options.status ?? 200) }),
        );
      }),
    ),
  );
  const dialog = Layer.succeed(DesktopShutdownConfirmation.DesktopShutdownConfirmation, {
    current: Effect.succeed(null),
    acknowledge: () => Effect.void,
    rendererReady: Effect.void,
    consumeQuitOverride: Effect.sync(() => {
      overrideChecks++;
      return options.quitOverride ?? false;
    }),
    resolve: () => Effect.void,
    request: (message) =>
      Effect.gen(function* () {
        messages.push(message);
        return (yield* options.dialog ?? Effect.succeed(0)) === 1;
      }),
  });
  return {
    messages,
    checks: () => checks,
    overrideChecks: () => overrideChecks,
    exchanges: () => exchanges,
    layer: Guard.layer.pipe(Layer.provide(Layer.mergeAll(pool, http, dialog))),
  };
}

describe("DesktopShutdownGuard", () => {
  it.effect("rechecks activity on every attempt but reuses authentication", () => {
    let active = false;
    const h = harness({
      activity: (port) =>
        Effect.succeed({ ...idle, activeSessions: active && port === "3774" ? 1 : 0 }),
    });
    return Effect.gen(function* () {
      const guard = yield* Guard.DesktopShutdownGuard;
      assert.isTrue(yield* guard.confirm("quit"));
      assert.lengthOf(h.messages, 0);
      active = true;
      assert.isFalse(yield* guard.confirm("restart", "Install update 9.0.363 and restart styal?"));
      assert.include(h.messages[0]!, "Install update 9.0.363 and restart styal?");
      assert.include(h.messages[0]!, "1 thread will be interrupted");
      assert.equal(h.checks(), 4);
      assert.equal(h.exchanges(), 2);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("allows explicit confirmation for waiting agents and terminal work", () => {
    const h = harness({
      activity: () =>
        Effect.succeed({ ...idle, waitingSessions: 1, terminalsRequiringConfirmation: 1 }),
      dialog: Effect.succeed(1),
    });
    return Effect.gen(function* () {
      const guard = yield* Guard.DesktopShutdownGuard;
      assert.isTrue(yield* guard.confirm("restart"));
      assert.include(h.messages[0]!, "2 threads waiting for input or approval will be interrupted");
      assert.include(h.messages[0]!, "2 terminal sessions");
    }).pipe(Effect.provide(h.layer));
  });
  for (const failure of ["http", "invalid", "defect"] as const) {
    it.effect(`requires confirmation on ${failure} failure`, () => {
      const h = harness({
        status: failure === "http" ? 404 : 200,
        activity: () =>
          failure === "defect"
            ? Effect.die("unavailable")
            : Effect.succeed(failure === "invalid" ? {} : idle),
      });
      return Effect.gen(function* () {
        const guard = yield* Guard.DesktopShutdownGuard;
        assert.isFalse(yield* guard.confirm("quit"));
        assert.include(h.messages[0]!, "could not be checked");
      }).pipe(Effect.provide(h.layer));
    });
  }
  it.effect("does not treat deliberately stopped backends as unavailable", () => {
    const h = harness({ stopped: true });
    return Effect.gen(function* () {
      const guard = yield* Guard.DesktopShutdownGuard;
      assert.isTrue(yield* guard.confirm("quit"));
      assert.equal(h.checks(), 0);
      assert.lengthOf(h.messages, 0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("times out checks and suppresses duplicate requests while confirmation is open", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const dialogOpened = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<number>();
      const h = harness({
        activity: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        dialog: Deferred.succeed(dialogOpened, undefined).pipe(
          Effect.andThen(Deferred.await(answer)),
        ),
      });
      yield* Effect.gen(function* () {
        const guard = yield* Guard.DesktopShutdownGuard;
        const first = yield* guard.confirm("quit").pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("3 seconds");
        yield* Deferred.await(dialogOpened);
        assert.isFalse(yield* guard.confirm("restart"));
        yield* Deferred.succeed(answer, 0);
        assert.isFalse(yield* Fiber.join(first));
        assert.lengthOf(h.messages, 1);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});

describe("shutdown confirmation copy", () => {
  it("states known work directly without an inspection warning", () => {
    assert.deepEqual(
      Guard.shutdownConfirmation(
        [{ ...idle, activeSessions: 1, terminalsRequiringConfirmation: 1 }],
        "quit",
      ),
      {
        message: "Quit with running work?",
        detail:
          "1 thread will be interrupted.\n1 terminal session will be interrupted. Make sure you're ready before continuing.",
      },
    );
  });
  it("separates busy terminals from failed inspections across environments", () => {
    assert.deepEqual(
      Guard.shutdownConfirmation(
        [
          { ...idle, terminalsRequiringConfirmation: 2, terminalsWithUnknownActivity: 1 },
          { ...idle, terminalsRequiringConfirmation: 1 },
        ],
        "restart",
      ),
      {
        message: "Restart with running work?",
        detail:
          "2 terminal sessions will be interrupted.\nActivity could not be checked for 1 terminal session.\n\nRestarting will stop any work hosted by this app. Make sure you're ready before continuing.",
      },
    );
  });
  it("does not claim running work when only inspection failed", () => {
    assert.deepEqual(
      Guard.shutdownConfirmation(
        [{ ...idle, terminalsRequiringConfirmation: 1, terminalsWithUnknownActivity: 1 }],
        "quit",
      ),
      {
        message: "Quit without checking activity?",
        detail:
          "Activity could not be checked for 1 terminal session.\n\nQuitting will stop any work hosted by this app. Make sure you're ready before continuing.",
      },
    );
  });
  it("describes waiting threads separately", () => {
    assert.deepEqual(Guard.shutdownConfirmation([{ ...idle, waitingSessions: 1 }], "restart"), {
      message: "Restart with waiting threads?",
      detail:
        "1 thread waiting for input or approval will be interrupted. Make sure you're ready before continuing.",
    });
  });
});

it.effect("only an explicit quit can consume the failed-presentation escape", () => {
  const h = harness({
    quitOverride: true,
    activity: () => Effect.succeed({ ...idle, activeSessions: 1 }),
  });
  return Effect.gen(function* () {
    const guard = yield* Guard.DesktopShutdownGuard;
    assert.isFalse(yield* guard.confirm("restart", "Install update 9.0.363 and restart styal?"));
    assert.isFalse(yield* guard.confirm("restart"));
    assert.equal(h.overrideChecks(), 0);
    assert.lengthOf(h.messages, 2);
    const checks = h.checks();
    assert.isTrue(yield* guard.confirm("quit"));
    assert.equal(h.overrideChecks(), 1);
    assert.equal(h.checks(), checks);
    assert.lengthOf(h.messages, 2);
  }).pipe(Effect.provide(h.layer));
});
