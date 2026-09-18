import { assert, describe, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { DesktopShutdownConfirmationRequest } from "@t3tools/contracts";
import * as Confirmation from "./DesktopShutdownConfirmation.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const harness = Effect.gen(function* () {
  const sent = yield* Deferred.make<DesktopShutdownConfirmationRequest>();
  const send = Effect.runSync;
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => false,
    send: (_channel: string, request: DesktopShutdownConfirmationRequest) =>
      send(Deferred.succeed(sent, request)),
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
  return { sent, window, layer };
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
          else h.window.webContents.emit(event, {}, "styal://app", false, true);
          assert.isFalse(yield* Fiber.join(request));
          assert.isNull(yield* service.current);
        }).pipe(Effect.provide(h.layer));
      }),
    );
  }
});
