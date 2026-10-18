import * as SecureStore from "expo-secure-store";
import { AGENT_AWARENESS_BACKGROUND_KEYS } from "../../persistence/mobile-secure-storage";

/**
 * Keychain options for every styal Link secret: the DPoP key, the saved
 * sign-in, and the access-token cache. Live Activity token reports can arrive
 * while the phone is locked, so these stay readable after the first unlock.
 * Android ignores the option.
 */
export const RELAY_KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Items written before the option existed were readable only while unlocked.
const MIGRATED_ITEM_KEYS = [
  "styal.cloud.dpop-proof-key",
  "styal.cloud.relay-access-tokens",
  ...AGENT_AWARENESS_BACKGROUND_KEYS,
];
const MIGRATION_MARKER_KEY = "styal.cloud.keychain-accessibility";
const MIGRATION_VERSION = "2";

let migration: Promise<void> | null = null;

/**
 * Re-saves existing styal Link items once so they take the accessibility
 * above. Writing an existing item updates its accessibility in place. A
 * failure (for example a locked phone) is retried on the next call.
 */
export function migrateRelayKeychainAccessibility(): Promise<void> {
  migration ??= (async () => {
    const marker = await SecureStore.getItemAsync(MIGRATION_MARKER_KEY, RELAY_KEYCHAIN_OPTIONS);
    if (marker === MIGRATION_VERSION) return;
    for (const key of MIGRATED_ITEM_KEYS) {
      const value = await SecureStore.getItemAsync(key, RELAY_KEYCHAIN_OPTIONS);
      if (value !== null) {
        await SecureStore.setItemAsync(key, value, RELAY_KEYCHAIN_OPTIONS);
      }
    }
    await SecureStore.setItemAsync(MIGRATION_MARKER_KEY, MIGRATION_VERSION, RELAY_KEYCHAIN_OPTIONS);
  })().catch((error: unknown) => {
    migration = null;
    throw error;
  });
  return migration;
}

export function __resetRelayKeychainMigrationForTest(): void {
  migration = null;
}
