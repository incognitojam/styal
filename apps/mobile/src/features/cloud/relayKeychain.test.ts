import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetRelayKeychainMigrationForTest,
  migrateRelayKeychainAccessibility,
} from "./relayKeychain";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "legacy",
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStore.delete(key);
  }),
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

it("retries legacy-token cleanup without changing relay secrets, then runs only once", async () => {
  secureStore.clear();
  secureStore.set("styal.cloud.keychain-accessibility", "2");
  secureStore.set("__clerk_client_jwt", "synthetic old credential");
  secureStore.set("styal.cloud.dpop-proof-key", "synthetic proof key");
  secureStore.set("styal.cloud.relay-session", "synthetic relay session");
  __resetRelayKeychainMigrationForTest();
  vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("locked"));
  await expect(migrateRelayKeychainAccessibility()).rejects.toThrow("locked");
  expect(secureStore.get("styal.cloud.keychain-accessibility")).toBe("2");
  expect(secureStore.get("__clerk_client_jwt")).toBe("synthetic old credential");
  await migrateRelayKeychainAccessibility();
  expect(secureStore.has("__clerk_client_jwt")).toBe(false);
  expect(secureStore.get("styal.cloud.dpop-proof-key")).toBe("synthetic proof key");
  expect(secureStore.get("styal.cloud.relay-session")).toBe("synthetic relay session");
  expect(secureStore.get("styal.cloud.keychain-accessibility")).toBe("3");
  const calls = vi.mocked(SecureStore.deleteItemAsync).mock.calls.length;
  await migrateRelayKeychainAccessibility();
  expect(vi.mocked(SecureStore.deleteItemAsync).mock.calls).toHaveLength(calls);
});
