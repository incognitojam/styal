import { assert, describe, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { SHUTDOWN_CONFIRMATION_CHANNEL } from "../ipc/channels.ts";
import * as Layer from "effect/Layer";
import type { DesktopShutdownConfirmationRequest } from "@t3tools/contracts";
import * as Confirmation from "./DesktopShutdownConfirmation.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const harness = Effect.gen(function* () {
  const sent = yield* Deferred.make<DesktopShutdownConfirmationRequest>();
  const nextSent = yield* Deferred.make<DesktopShutdownConfirmationRequest>();
  let count = 0;
  const send = Effect.runSync;
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, request: DesktopShutdownConfirmationRequest) => {
      if (channel === SHUTDOWN_CONFIRMATION_CHANNEL)
        send(Deferred.succeed(count++ === 0 ? sent : nextSent, request));
    },
  });
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    webContents,
    isDestroyed: () => false,
  });
  const layer = Confirmation.layer.pipe(
    Layer.provide(
      Layer.mock(DesktopWindow.DesktopWindow)({
        revealOrCreateMain: Effect.succeed(window as unknown as Electron.BrowserWindow),
      }),
    ),
  );
  return { sent, nextSent, window, layer };
});

describe("DesktopShutdownConfirmation", () => {
  for (const confirmed of [false, true]) {
    it.effect(`resolves ${confirmed} from the matching renderer response`, () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* Effect.gen(function* () {
          const service = yield* Confirmation.DesktopShutdownConfirmation;
          const request = yield* service
            .request("Restart with running work?")
            .pipe(Effect.forkChild);
          const sent = yield* Deferred.await(h.sent);
          // A newly opened renderer can recover the request after mounting.
          assert.deepEqual(yield* service.current, sent);
          yield* service.resolve(sent.requestId + 1, !confirmed);
          assert.deepEqual(yield* service.current, sent);
          yield* service.acknowledge(sent.requestId);
          yield* service.resolve(sent.requestId, confirmed);
          assert.equal(yield* Fiber.join(request), confirmed);
          assert.isNull(yield* service.current);
          assert.equal(h.window.listenerCount("closed"), 0);
          assert.equal(h.window.webContents.listenerCount("did-start-navigation"), 0);
        }).pipe(Effect.provide(h.layer));
      }),
    );
  }
  for (const event of ["closed", "render-process-gone", "did-fail-load", "did-start-navigation"]) {
    it.effect(`cancels when the renderer becomes unavailable: ${event}`, () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* Effect.gen(function* () {
          const service = yield* Confirmation.DesktopShutdownConfirmation;
          const request = yield* service.request("Quit with running work?").pipe(Effect.forkChild);
          yield* Deferred.await(h.sent);
          if (event === "closed") h.window.emit(event);
          else if (event === "did-fail-load")
            h.window.webContents.emit(event, {}, -1, "failed", "styal://app", true);
          else h.window.webContents.emit(event, {}, "styal://app", false, true);
          assert.isFalse(yield* Fiber.join(request));
          assert.isNull(yield* service.current);
          assert.equal(yield* service.consumeQuitOverride, event !== "closed");
        }).pipe(Effect.provide(h.layer));
      }),
    );
  }
});

describe("shutdown presentation failure", () => {
  it.effect("expires unacknowledged requests and ignores late acknowledgments and responses", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* Confirmation.DesktopShutdownConfirmation;
        const first = yield* service.request("Quit?").pipe(Effect.forkChild);
        const sent = yield* Deferred.await(h.sent);
        yield* service.resolve(sent.requestId, true);
        yield* TestClock.adjust("5 seconds");
        assert.isFalse(yield* Fiber.join(first));
        assert.isNull(yield* service.current);
        yield* service.acknowledge(sent.requestId);
        yield* service.resolve(sent.requestId, true);
        assert.isTrue(yield* service.consumeQuitOverride);
        assert.isFalse(yield* service.consumeQuitOverride);
      }).pipe(Effect.provide(h.layer));
    }),
  );
  it.effect("does not time out a displayed dialog", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* Confirmation.DesktopShutdownConfirmation;
        const done = yield* Deferred.make<boolean>();
        const request = yield* service.request("Quit?").pipe(
          Effect.tap((result) => Deferred.succeed(done, result)),
          Effect.forkChild,
        );
        const sent = yield* Deferred.await(h.sent);
        yield* service.acknowledge(sent.requestId);
        yield* TestClock.adjust("1 day");
        assert.isFalse(yield* Deferred.isDone(done));
        assert.isFalse(yield* service.consumeQuitOverride);
        yield* service.resolve(sent.requestId, false);
        assert.isFalse(yield* Fiber.join(request));
        assert.isFalse(yield* service.consumeQuitOverride);
      }).pipe(Effect.provide(h.layer));
    }),
  );
  for (const recovery of ["ready", "displayed"] as const) {
    it.effect(`clears the escape after renderer recovery: ${recovery}`, () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* Effect.gen(function* () {
          const service = yield* Confirmation.DesktopShutdownConfirmation;
          const first = yield* service.request("Quit?").pipe(Effect.forkChild);
          const old = yield* Deferred.await(h.sent);
          yield* TestClock.adjust("5 seconds");
          yield* Fiber.join(first);
          if (recovery === "ready") {
            yield* service.rendererReady;
          } else {
            const second = yield* service.request("Restart?").pipe(Effect.forkChild);
            const next = yield* Deferred.await(h.nextSent);
            assert.notEqual(old.requestId, next.requestId);
            yield* service.acknowledge(old.requestId);
            yield* service.resolve(old.requestId, true);
            assert.deepEqual(yield* service.current, next);
            yield* service.acknowledge(next.requestId);
            yield* service.resolve(next.requestId, false);
            assert.isFalse(yield* Fiber.join(second));
          }
          assert.isFalse(yield* service.consumeQuitOverride);
        }).pipe(Effect.provide(h.layer));
      }),
    );
  }
  it.effect("arms the escape if a displayed renderer crashes", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* Confirmation.DesktopShutdownConfirmation;
        const request = yield* service.request("Quit?").pipe(Effect.forkChild);
        const sent = yield* Deferred.await(h.sent);
        yield* service.acknowledge(sent.requestId);
        h.window.webContents.emit("render-process-gone");
        assert.isFalse(yield* Fiber.join(request));
        assert.isTrue(yield* service.consumeQuitOverride);
      }).pipe(Effect.provide(h.layer));
    }),
  );
  it.effect("interruption cleans up without arming an escape", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* Confirmation.DesktopShutdownConfirmation;
        const request = yield* service.request("Quit?").pipe(Effect.forkChild);
        yield* Deferred.await(h.sent);
        yield* Fiber.interrupt(request);
        assert.isNull(yield* service.current);
        assert.isFalse(yield* service.consumeQuitOverride);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});
