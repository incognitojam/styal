import type * as NodeEvents from "node:events";
import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const native = vi.hoisted(() => ({
  notifications: [] as Array<NodeEvents.EventEmitter & { options: object; close: () => void }>,
  window: {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  },
  contents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Notification extends EventEmitter {
    readonly close = vi.fn(() => this.emit("close"));
    readonly options: object;
    constructor(options: object) {
      super();
      this.options = options;
      native.notifications.push(this);
    }
    show() {}
  }
  return {
    Notification,
    webContents: { fromId: (id: number) => (id === 7 ? native.contents : null) },
    BrowserWindow: { fromWebContents: () => native.window },
  };
});

import * as DesktopIpc from "../DesktopIpc.ts";
import { installSystemNotifications } from "./systemNotifications.ts";

const event = { sender: { id: 7 } };
const payload = { title: "Thread completed", body: "Fix the login form", tag: "abc" };

beforeEach(() => {
  vi.clearAllMocks();
  native.notifications.length = 0;
});

const install = Effect.fn(function* () {
  const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  yield* installSystemNotifications().pipe(
    Effect.provideService(
      DesktopIpc.DesktopIpc,
      DesktopIpc.make({
        handle: (channel, listener) => void handlers.set(channel, listener),
        removeHandler: (channel) => void handlers.delete(channel),
        on: () => undefined,
        removeAllListeners: () => undefined,
      }),
    ),
  );
  return {
    show: (input: unknown) =>
      Promise.resolve(handlers.get("desktop:show-system-notification")!(event, input)),
    close: (tag: string) =>
      Promise.resolve(handlers.get("desktop:close-system-notification")!(event, tag)),
  };
});

const latest = () => native.notifications.at(-1)!;

it.effect("reports blocked when macOS rejects the notification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ipc = yield* install();
      const shown = ipc.show(payload);
      latest().emit("show", {});
      expect(yield* Effect.promise(() => shown)).toBe("shown");
      expect(latest().options).toEqual({ title: payload.title, body: payload.body, silent: true });

      const blocked = ipc.show({ ...payload, tag: "def" });
      latest().emit("failed", {}, "Notifications are not allowed for this application");
      expect(yield* Effect.promise(() => blocked)).toBe("blocked");
    }),
  ),
);

it.effect("raises the sending window and returns the tag on click", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ipc = yield* install();
      void ipc.show(payload);
      latest().emit("click");
      expect(native.window.restore).toHaveBeenCalled();
      expect(native.window.focus).toHaveBeenCalled();
      expect(native.contents.send).toHaveBeenCalledWith("desktop:system-notification-click", "abc");
    }),
  ),
);

it.effect("replaces a notification with the same tag and closes by tag", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ipc = yield* install();
      void ipc.show(payload);
      const first = latest();
      void ipc.show(payload);
      expect(first.close).toHaveBeenCalledTimes(1);
      const second = latest();
      yield* Effect.promise(() => ipc.close("abc"));
      expect(second.close).toHaveBeenCalledTimes(1);
      yield* Effect.promise(() => expect(ipc.show({ ...payload, tag: "" })).rejects.toBeDefined());
    }),
  ),
);
