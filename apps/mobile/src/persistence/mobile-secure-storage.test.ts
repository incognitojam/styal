import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SecureStore from "expo-secure-store";

import * as MobileStorage from "./mobile-storage";
import * as MobileSecureStorage from "./mobile-secure-storage";
import {
  __resetRelayKeychainMigrationForTest,
  migrateRelayKeychainAccessibility,
} from "../features/cloud/relayKeychain";

const state = vi.hoisted(() => ({
  locked: false,
  items: new Map<string, { value: string; accessibility: string }>(),
}));
const DEVICE_KEY = "styal.agent-awareness.device-id";
const REGISTRATION_KEY = "styal.agent-awareness.registration";
const MARKER_KEY = "styal.cloud.keychain-accessibility";
const accessible = "after-first-unlock-this-device-only";

vi.mock("../lib/uuid", () => ({ uuidv4: () => "synthetic-device-id" }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "after-first-unlock-this-device-only",
  getItemAsync: vi.fn((key: string) => {
    const item = state.items.get(key);
    if (state.locked && item?.accessibility === "when-unlocked") {
      return Promise.reject(new Error("errSecInteractionNotAllowed"));
    }
    return Promise.resolve(item?.value ?? null);
  }),
  setItemAsync: vi.fn((key: string, value: string, options?: { keychainAccessible?: string }) => {
    state.items.set(key, {
      value,
      accessibility:
        options?.keychainAccessible ?? state.items.get(key)?.accessibility ?? "when-unlocked",
    });
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    state.items.delete(key);
    return Promise.resolve();
  }),
}));

const makeStorage = MobileStorage.make().pipe(Effect.provide(MobileSecureStorage.layer));
const registration = { identity: "synthetic-account", signature: "synthetic-registration" };

beforeEach(() => {
  state.locked = false;
  state.items.clear();
  vi.clearAllMocks();
  __resetRelayKeychainMigrationForTest();
});

describe("background registration storage", () => {
  it.effect("migrates the device id and registration left by an earlier relay migration", () =>
    Effect.gen(function* () {
      state.items.set(MARKER_KEY, { value: "1", accessibility: accessible });
      state.items.set(DEVICE_KEY, { value: "existing-device", accessibility: "when-unlocked" });
      state.items.set(REGISTRATION_KEY, {
        value: JSON.stringify(registration),
        accessibility: "when-unlocked",
      });
      state.items.set("styal.connections", {
        value: "private-connections",
        accessibility: "when-unlocked",
      });
      const storage = yield* makeStorage;

      yield* Effect.promise(() => migrateRelayKeychainAccessibility());
      expect(state.items.get(MARKER_KEY)?.value).toBe("2");
      state.locked = true;
      __resetRelayKeychainMigrationForTest();
      vi.mocked(SecureStore.setItemAsync).mockClear();
      yield* Effect.promise(() => migrateRelayKeychainAccessibility());
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
      expect(yield* storage.loadOrCreateAgentAwarenessDeviceId).toBe("existing-device");
      expect(yield* storage.loadAgentAwarenessDeviceId).toBe("existing-device");
      expect(yield* storage.loadAgentAwarenessRegistrationRecord).toEqual(registration);
      yield* storage.saveAgentAwarenessRegistrationRecord({
        ...registration,
        signature: "rotated",
      });
      expect(yield* storage.loadAgentAwarenessRegistrationRecord).toEqual({
        ...registration,
        signature: "rotated",
      });
      expect(state.items.get("styal.connections")?.accessibility).toBe("when-unlocked");
      const connections = yield* Effect.exit(storage.loadSavedConnections);
      expect(connections._tag).toBe("Failure");
    }),
  );

  it.effect(
    "writes new registration prerequisites with background accessibility only for those keys",
    () =>
      Effect.gen(function* () {
        const storage = yield* makeStorage;
        expect(yield* storage.loadOrCreateAgentAwarenessDeviceId).toBe("synthetic-device-id");
        yield* storage.saveAgentAwarenessRegistrationRecord(registration);
        yield* MobileSecureStorage.make.setItem("styal.connections", "connections");
        state.locked = true;
        expect(yield* storage.loadOrCreateAgentAwarenessDeviceId).toBe("synthetic-device-id");
        expect(yield* storage.loadAgentAwarenessRegistrationRecord).toEqual(registration);
        expect(state.items.get(DEVICE_KEY)?.accessibility).toBe(accessible);
        expect(state.items.get(REGISTRATION_KEY)?.accessibility).toBe(accessible);
        expect(state.items.get("styal.connections")?.accessibility).toBe("when-unlocked");
        yield* storage.clearAgentAwarenessRegistrationRecord;
        expect(yield* storage.loadAgentAwarenessRegistrationRecord).toBeNull();
      }),
  );

  it.effect("retries an incomplete migration without changing its marker", () =>
    Effect.gen(function* () {
      state.items.set(MARKER_KEY, { value: "1", accessibility: accessible });
      state.items.set(DEVICE_KEY, { value: "existing-device", accessibility: "when-unlocked" });
      vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("keychain unavailable"));
      const failure = yield* Effect.flip(
        Effect.tryPromise(() => migrateRelayKeychainAccessibility()),
      );
      expect(failure.cause).toEqual(new Error("keychain unavailable"));
      expect(state.items.get(MARKER_KEY)?.value).toBe("1");
      yield* Effect.promise(() => migrateRelayKeychainAccessibility());
      state.locked = true;
      const storage = yield* makeStorage;
      expect(yield* storage.loadAgentAwarenessDeviceId).toBe("existing-device");
      expect(state.items.get(MARKER_KEY)?.value).toBe("2");
    }),
  );
});
