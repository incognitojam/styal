import { useSyncExternalStore } from "react";

import { toastManager } from "./components/ui/toast";
import { readLocalApi } from "./localApi";

export interface SystemNotificationHandle {
  readonly close: () => void;
}

interface SystemNotificationOptions {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly onClick?: () => void;
}

let blocked = false;
let blockedToastShown = false;
const blockedListeners = new Set<() => void>();
const clickHandlers = new Map<string, () => void>();
let unsubscribeClicks: (() => void) | undefined;

function setBlocked(next: boolean) {
  if (blocked === next) return;
  blocked = next;
  for (const listener of blockedListeners) listener();
}

/** True after macOS rejected the last notification the desktop app sent. */
export function useSystemNotificationsBlocked() {
  return useSyncExternalStore(
    (listener) => {
      blockedListeners.add(listener);
      return () => blockedListeners.delete(listener);
    },
    () => blocked,
  );
}

export function openNotificationSystemSettings() {
  return readLocalApi()
    ?.shell.openSystemSettings("notifications")
    .catch(() => {
      toastManager.add({ type: "error", title: "Could not open System Settings" });
    });
}

function warnBlockedOnce() {
  if (blockedToastShown) return;
  blockedToastShown = true;
  const toastId = toastManager.add({
    type: "warning",
    title: "macOS is blocking styal notifications",
    description: "Allow notifications for styal in System Settings to get thread alerts.",
    actionProps: {
      children: "Open System Settings",
      onClick: () => {
        toastManager.close(toastId);
        void openNotificationSystemSettings();
      },
    },
  });
}

/**
 * Shows a system notification. On macOS desktop the main process presents it, because
 * Chromium reports `granted` and drops notifications that macOS blocks.
 */
export function showSystemNotification({
  title,
  body,
  tag,
  onClick,
}: SystemNotificationOptions): SystemNotificationHandle | null {
  const bridge = window.desktopBridge;
  if (bridge?.showSystemNotification) {
    unsubscribeClicks ??= bridge.onSystemNotificationClick?.((clickedTag) => {
      const handler = clickHandlers.get(clickedTag);
      clickHandlers.delete(clickedTag);
      handler?.();
    });
    if (onClick) clickHandlers.set(tag, onClick);
    else clickHandlers.delete(tag);
    void bridge.showSystemNotification({ title, body, tag }).then(
      (result) => {
        setBlocked(result === "blocked");
        if (result === "blocked") warnBlockedOnce();
      },
      () => undefined,
    );
    return {
      close: () => {
        if (clickHandlers.get(tag) === onClick) clickHandlers.delete(tag);
        void bridge.closeSystemNotification?.(tag).catch(() => undefined);
      },
    };
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  try {
    const notification = new Notification(title, { body, tag, silent: true });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      void window.desktopBridge?.revealWindow?.().catch(() => undefined);
      onClick?.();
    });
    return notification;
  } catch {
    // Some browsers expose Notification but reject desktop presentation.
    return null;
  }
}

/**
 * Sends a confirmation notification and reports whether macOS blocked it. Elsewhere the
 * browser permission is the only signal, so this always reports false.
 */
export async function testSystemNotificationBlocked(): Promise<boolean> {
  const bridge = window.desktopBridge;
  if (!bridge?.showSystemNotification) return false;
  const result = await bridge
    .showSystemNotification({
      title: "Notifications are on",
      body: "styal will alert you here when a thread finishes or needs you.",
      tag: "styal:notification-test",
    })
    .catch(() => "shown" as const);
  setBlocked(result === "blocked");
  return result === "blocked";
}
