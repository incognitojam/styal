import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Notifications from "expo-notifications";
import { requestAgentNotificationPermission } from "./notificationPermissions";

const platform = vi.hoisted(() => ({ OS: "android" }));
const createChannels = vi.hoisted(() => vi.fn(() => false));
vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("./androidNotifications", () => ({ createAndroidAgentChannels: createChannels }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  setNotificationChannelAsync: vi.fn(() => Promise.resolve(null)),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: false, canAskAgain: true })),
  requestPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true, canAskAgain: true })),
}));

describe("agent notification permission", () => {
  it.effect("creates the native channels instead of Expo's when the binary supports them", () =>
    Effect.gen(function* () {
      createChannels.mockReturnValueOnce(true);
      expect(yield* requestAgentNotificationPermission).toEqual({ type: "granted" });
      expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
      expect(createChannels.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(Notifications.requestPermissionsAsync).mock.invocationCallOrder[0]!,
      );
    }),
  );
});
