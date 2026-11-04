import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const UN_AUTHORIZATION_STATUS_DENIED = 1;

/**
 * True when "Allow notifications" is off for this app in System Settings. Electron still
 * emits `show` for notifications macOS discards in that state, so ask UserNotifications.
 * Reports false when the status cannot be read, leaving Electron's own events to decide.
 */
export const macNotificationsDenied = Effect.fn("desktop.macNotificationsDenied")(
  function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return false;
    // Loaded on first use: the module and its native addon ship on macOS alone.
    const objc = yield* Effect.tryPromise(() => import("objc-js"));
    const status = yield* Effect.callback<unknown>((resume) => {
      try {
        const userNotifications = new objc.NobjcLibrary(
          "/System/Library/Frameworks/UserNotifications.framework/UserNotifications",
        );
        const center = userNotifications.UNUserNotificationCenter?.currentNotificationCenter?.();
        center.getNotificationSettingsWithCompletionHandler$(
          objc.typedBlock({ returns: "v", args: ["@"] }, (settings) =>
            resume(Effect.succeed(settings.authorizationStatus())),
          ),
        );
      } catch {
        resume(Effect.void);
      }
    });
    return status === UN_AUTHORIZATION_STATUS_DENIED;
  },
  Effect.orElseSucceed(() => false),
);
