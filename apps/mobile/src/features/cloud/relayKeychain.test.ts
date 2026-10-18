import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetRelayKeychainMigrationForTest,
  migrateRelayKeychainAccessibility,
} from "./relayKeychain";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "after-first-unlock-this-device-only",
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
}));

const options = { keychainAccessible: "after-first-unlock-this-device-only" };

beforeEach(() => {
  secureStore.clear();
  vi.mocked(SecureStore.getItemAsync).mockClear();
  vi.mocked(SecureStore.setItemAsync).mockClear();
  __resetRelayKeychainMigrationForTest();
});

describe("relay keychain accessibility", () => {
  it("re-saves existing items once so a locked phone can still read them", async () => {
    secureStore.set("styal.cloud.dpop-proof-key", "private-key");

    await migrateRelayKeychainAccessibility();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "styal.cloud.dpop-proof-key",
      "private-key",
      options,
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "styal.cloud.relay-access-tokens",
      expect.anything(),
      expect.anything(),
    );

    __resetRelayKeychainMigrationForTest();
    vi.mocked(SecureStore.setItemAsync).mockClear();
    await migrateRelayKeychainAccessibility();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("tries again after a read fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("keychain locked"));
    await expect(migrateRelayKeychainAccessibility()).rejects.toThrow("keychain locked");

    secureStore.set("styal.cloud.relay-access-tokens", "cached-tokens");
    await migrateRelayKeychainAccessibility();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "styal.cloud.relay-access-tokens",
      "cached-tokens",
      options,
    );
  });
});
