import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";

const LEGACY_STORAGE_PREFIX = "t3code:";
const LEGACY_PROMPT_STASH_KEYS = ["t3code:prompt-stash:v2", "t3code:prompt-stash:v1"];
const LEGACY_DATABASE_NAMES = ["t3code:connection-runtime", "t3code:cloud-auth"];
const CLEANUP_MARKER_KEY = "styal:hosted-t3code-storage-cleanup:v1";

const STYAL_HOSTED_ORIGINS = new Set([new URL(DEFAULT_HOSTED_APP_URL).origin]);

export function isKnownStyalHostedOrigin(origin: string): boolean {
  try {
    return STYAL_HOSTED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function deleteDatabase(indexedDb: IDBFactory, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = indexedDb.deleteDatabase(name);
      request.addEventListener("success", () => resolve(true), { once: true });
      request.addEventListener("error", () => resolve(false), { once: true });
      request.addEventListener("blocked", () => resolve(false), { once: true });
    } catch {
      resolve(false);
    }
  });
}

export async function cleanupAbandonedHostedStorage(input: {
  readonly origin: string;
  readonly storage?: Storage;
  readonly indexedDb?: IDBFactory;
}): Promise<boolean> {
  if (!isKnownStyalHostedOrigin(input.origin) || input.storage === undefined) {
    return false;
  }

  const { storage } = input;
  try {
    if (storage.getItem(CLEANUP_MARKER_KEY) !== null) {
      return false;
    }

    // Stashed images can occupy most of the origin's localStorage quota, so
    // free them before enumerating smaller abandoned preferences.
    for (const key of LEGACY_PROMPT_STASH_KEYS) {
      storage.removeItem(key);
    }

    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_STORAGE_PREFIX)) {
        storage.removeItem(key);
      }
    }
  } catch {
    return false;
  }

  const { indexedDb } = input;
  const databasesDeleted =
    indexedDb === undefined
      ? true
      : (
          await Promise.all(LEGACY_DATABASE_NAMES.map((name) => deleteDatabase(indexedDb, name)))
        ).every(Boolean);

  if (!databasesDeleted) {
    return false;
  }

  try {
    storage.setItem(CLEANUP_MARKER_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function cleanupAbandonedHostedBrowserStorage(): Promise<boolean> {
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return Promise.resolve(false);
  }

  return cleanupAbandonedHostedStorage({
    origin: window.location.origin,
    storage,
    ...(typeof indexedDB === "undefined" ? {} : { indexedDb: indexedDB }),
  });
}
