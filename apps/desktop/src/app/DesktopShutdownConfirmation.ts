import type { DesktopShutdownConfirmationRequest } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  SHUTDOWN_CONFIRMATION_CHANNEL,
  SHUTDOWN_CONFIRMATION_EXPIRED_CHANNEL,
} from "../ipc/channels.ts";

export const PRESENTATION_TIMEOUT = "5 seconds";

export class DesktopShutdownConfirmation extends Context.Service<
  DesktopShutdownConfirmation,
  {
    readonly request: (message: string) => Effect.Effect<boolean>;
    readonly current: Effect.Effect<DesktopShutdownConfirmationRequest | null>;
    readonly acknowledge: (requestId: number) => Effect.Effect<void>;
    readonly rendererReady: Effect.Effect<void>;
    readonly consumeQuitOverride: Effect.Effect<boolean>;
    readonly resolve: (requestId: number, confirmed: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopShutdownConfirmation") {}

export const make = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  let nextId = 0;
  let quitOverride = false;
  let pending: {
    request: DesktopShutdownConfirmationRequest;
    presented: boolean;
    expired: boolean;
    resolve: (confirmed: boolean) => void;
  } | null = null;

  return DesktopShutdownConfirmation.of({
    current: Effect.sync(() => (pending && !pending.expired ? pending.request : null)),
    rendererReady: Effect.sync(() => {
      quitOverride = false;
    }),
    consumeQuitOverride: Effect.sync(() => {
      if (pending || !quitOverride) return false;
      quitOverride = false;
      return true;
    }),
    acknowledge: (requestId) =>
      Effect.sync(() => {
        if (pending?.request.requestId !== requestId || pending.expired) return;
        pending.presented = true;
        quitOverride = false;
      }),
    resolve: (requestId, confirmed) =>
      Effect.sync(() => {
        if (pending?.request.requestId === requestId && pending.presented && !pending.expired) {
          pending.resolve(confirmed);
        }
      }),
    request: (message) =>
      Effect.gen(function* () {
        if (pending) return false;
        const window = yield* desktopWindow.revealOrCreateMain.pipe(
          Effect.timeout(PRESENTATION_TIMEOUT),
        );
        const request = { requestId: ++nextId, message };
        let cleanup = () => {};
        let responded = false;
        const failPresentation = () => {
          if (pending?.request.requestId !== request.requestId || pending.expired) return;
          pending.expired = true;
          quitOverride = true;
          pending.resolve(false);
        };
        const response = Effect.callback<boolean>((resume) => {
          const resolve = (confirmed: boolean) => resume(Effect.succeed(confirmed));
          const cancel = () => resolve(false);
          const onNavigation = (
            _event: Electron.Event,
            _url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
          ) => {
            if (isMainFrame && !isInPlace) failPresentation();
          };
          const onLoadFailed = (
            _event: Electron.Event,
            _code: number,
            _description: string,
            _url: string,
            isMainFrame: boolean,
          ) => {
            if (isMainFrame) failPresentation();
          };
          pending = {
            request,
            presented: false,
            expired: false,
            resolve: (confirmed) => {
              responded = !pending?.expired;
              resolve(confirmed);
            },
          };
          cleanup = () => {
            pending = null;
            window.removeListener("closed", cancel);
            window.webContents.removeListener("render-process-gone", failPresentation);
            window.webContents.removeListener("did-fail-load", onLoadFailed);
            window.webContents.removeListener("did-start-navigation", onNavigation);
            if (!responded && !window.webContents.isDestroyed()) {
              // Expired queued dialogs must never appear later or authorize shutdown.
              try {
                window.webContents.send(SHUTDOWN_CONFIRMATION_EXPIRED_CHANNEL, request.requestId);
              } catch {
                /* Renderer already gone. */
              }
            }
          };
          window.once("closed", cancel);
          window.webContents.once("render-process-gone", failPresentation);
          window.webContents.on("did-fail-load", onLoadFailed);
          window.webContents.on("did-start-navigation", onNavigation);
          try {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
              window.webContents.send(SHUTDOWN_CONFIRMATION_CHANNEL, request);
            } else {
              failPresentation();
            }
          } catch {
            failPresentation();
          }
        });
        const presentationDeadline = Effect.sleep(PRESENTATION_TIMEOUT).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (pending?.presented) return Effect.never;
              failPresentation();
              return Effect.succeed(false);
            }),
          ),
        );
        return yield* Effect.raceFirst(response, presentationDeadline).pipe(
          Effect.ensuring(Effect.sync(() => cleanup())),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => {
                quitOverride = true;
                return false;
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(DesktopShutdownConfirmation, make);
