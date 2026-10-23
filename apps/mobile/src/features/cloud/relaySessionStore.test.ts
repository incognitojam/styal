import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SecureStore from "expo-secure-store";
import { beforeEach, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  endRelaySession,
  loadStoredRelaySession,
  publishRelaySignIn,
  relaySignInAtom,
  saveStoredRelaySession,
  type StoredRelaySession,
} from "./relaySessionStore";

const SESSION_KEY = "styal.cloud.relay-session";
const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "after-first-unlock-this-device-only",
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  }),
}));

const record: StoredRelaySession = {
  version: 1,
  relayUrl: "https://relay.example.test",
  accountId: "account-1",
  email: null,
  refreshToken: "styal_rt_session_secret",
  thumbprint: "key-thumbprint",
};

beforeEach(() => {
  secureStore.clear();
  vi.mocked(SecureStore.setItemAsync).mockClear();
  appAtomRegistry.set(relaySignInAtom, { status: "loading" });
});

describe("relay session store", () => {
  it.effect("round-trips the sign-in, readable after the first unlock on this device only", () =>
    Effect.gen(function* () {
      yield* saveStoredRelaySession(record);
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(SESSION_KEY, expect.any(String), {
        keychainAccessible: "after-first-unlock-this-device-only",
      });
      expect(yield* loadStoredRelaySession).toEqual(record);
    }),
  );

  it.effect("reads a malformed record as signed out", () =>
    Effect.gen(function* () {
      secureStore.set(SESSION_KEY, JSON.stringify({ ...record, version: 2 }));
      expect(yield* loadStoredRelaySession).toBeNull();
    }),
  );

  it("keeps the published session when the same sign-in is published again", () => {
    publishRelaySignIn(record);
    const first = appAtomRegistry.get(relaySignInAtom);
    publishRelaySignIn({ ...record });
    expect(appAtomRegistry.get(relaySignInAtom)).toBe(first);
  });

  it.effect("drops an ended session, but not a newer sign-in that replaced it", () =>
    Effect.gen(function* () {
      yield* saveStoredRelaySession(record);
      publishRelaySignIn(record);

      yield* endRelaySession({ accountId: "account-1", refreshToken: "styal_rt_older_secret" });
      expect(secureStore.has(SESSION_KEY)).toBe(true);
      expect(appAtomRegistry.get(relaySignInAtom)).toMatchObject({ status: "ready" });

      yield* endRelaySession({ accountId: "account-1", refreshToken: record.refreshToken });
      expect(secureStore.has(SESSION_KEY)).toBe(false);
      expect(appAtomRegistry.get(relaySignInAtom)).toEqual({ status: "ready", session: null });
    }),
  );
});
