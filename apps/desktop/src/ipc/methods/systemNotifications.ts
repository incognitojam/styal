import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DesktopSystemNotificationResultSchema,
  DesktopSystemNotificationSchema,
  type DesktopSystemNotificationResult,
} from "@t3tools/contracts";

import * as DesktopIpc from "../DesktopIpc.ts";
import {
  CLOSE_SYSTEM_NOTIFICATION_CHANNEL,
  SHOW_SYSTEM_NOTIFICATION_CHANNEL,
  SYSTEM_NOTIFICATION_CLICK_CHANNEL,
} from "../channels.ts";

const NotificationTag = DesktopSystemNotificationSchema.fields.tag;

export const installSystemNotifications = Effect.fn("desktop.ipc.installSystemNotifications")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    // Keyed by sender and tag. Holding the reference keeps click events alive.
    const shown = new Map<string, Electron.Notification>();
    const close = (key: string) => {
      const notification = shown.get(key);
      shown.delete(key);
      notification?.close();
    };

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SHOW_SYSTEM_NOTIFICATION_CHANNEL,
        payload: DesktopSystemNotificationSchema,
        result: DesktopSystemNotificationResultSchema,
        handler: ({ title, body, tag }, event) =>
          Effect.callback<DesktopSystemNotificationResult>((resume) => {
            const senderId = event?.sender.id;
            const key = `${senderId}:${tag}`;
            close(key);
            const notification = new Electron.Notification({ title, body, silent: true });
            shown.set(key, notification);
            notification.once("show", () => resume(Effect.succeed("shown")));
            // macOS rejects every request while the app's notifications are off in System Settings.
            notification.once("failed", (_event, error) => {
              if (shown.get(key) === notification) shown.delete(key);
              resume(
                Effect.logWarning("System notification failed", error).pipe(Effect.as("blocked")),
              );
            });
            notification.on("close", () => {
              if (shown.get(key) === notification) shown.delete(key);
            });
            notification.on("click", () => {
              if (shown.get(key) === notification) shown.delete(key);
              const contents =
                senderId === undefined ? null : Electron.webContents.fromId(senderId);
              if (!contents || contents.isDestroyed()) return;
              const window = Electron.BrowserWindow.fromWebContents(contents);
              if (window && !window.isDestroyed()) {
                if (window.isMinimized()) window.restore();
                window.show();
                window.focus();
              }
              contents.send(SYSTEM_NOTIFICATION_CLICK_CHANNEL, tag);
            });
            notification.show();
          }),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: CLOSE_SYSTEM_NOTIFICATION_CHANNEL,
        payload: NotificationTag,
        result: Schema.Void,
        handler: (tag, event) => Effect.sync(() => close(`${event?.sender.id}:${tag}`)),
      }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const key of shown.keys()) close(key);
      }),
    );
  },
);
