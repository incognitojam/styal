import type { DesktopShutdownConfirmationRequest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { SHUTDOWN_CONFIRMATION_CHANNEL } from "../ipc/channels.ts";

export class DesktopShutdownConfirmation extends Context.Service<
  DesktopShutdownConfirmation,
  {
    readonly request: (message: string) => Effect.Effect<boolean>;
    readonly current: Effect.Effect<DesktopShutdownConfirmationRequest | null>;
    readonly resolve: (requestId: number, confirmed: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopShutdownConfirmation") {}

export const make = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  let nextId = 0;
  let pending: {
    request: DesktopShutdownConfirmationRequest;
    resolve: (confirmed: boolean) => void;
  } | null = null;

  return DesktopShutdownConfirmation.of({
    current: Effect.sync(() => pending?.request ?? null),
    resolve: (requestId, confirmed) =>
      Effect.sync(() => {
        if (pending?.request.requestId === requestId) pending.resolve(confirmed);
      }),
    request: (message) =>
      Effect.gen(function* () {
        if (pending) return false;
        const window = yield* desktopWindow.revealOrCreateMain;
        let cleanup = () => {};
        return yield* Effect.callback<boolean>((resume) => {
          const request = { requestId: ++nextId, message };
          const resolve = (confirmed: boolean) => resume(Effect.succeed(confirmed));
          const cancel = () => resolve(false);
          const onNavigation = (
            _event: Electron.Event,
            _url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
          ) => {
            if (isMainFrame && !isInPlace) cancel();
          };
          pending = { request, resolve };
          window.once("closed", cancel);
          window.webContents.once("render-process-gone", cancel);
          window.webContents.once("did-fail-load", cancel);
          window.webContents.on("did-start-navigation", onNavigation);
          // Newly created renderers fetch the pending request after their dialog host mounts.
          try {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
              window.webContents.send(SHUTDOWN_CONFIRMATION_CHANNEL, request);
            } else {
              cancel();
            }
          } catch {
            cancel();
          }
          cleanup = () => {
            pending = null;
            window.removeListener("closed", cancel);
            window.webContents.removeListener("render-process-gone", cancel);
            window.webContents.removeListener("did-fail-load", cancel);
            window.webContents.removeListener("did-start-navigation", onNavigation);
          };
        }).pipe(Effect.ensuring(Effect.sync(() => cleanup())));
      }).pipe(Effect.catchCause(() => Effect.succeed(false))),
  });
});

export const layer = Layer.effect(DesktopShutdownConfirmation, make);
