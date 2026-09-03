import { describe, expect, it, vi } from "vite-plus/test";

import { cleanupAbandonedHostedStorage, isKnownStyalHostedOrigin } from "./hostedStorageCleanup";

function createStorage(entries: Record<string, string>): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function createIndexedDb(result: "success" | "error" | "blocked" = "success") {
  const deleteDatabase = vi.fn(() => {
    const request = new EventTarget();
    queueMicrotask(() => request.dispatchEvent(new Event(result)));
    return request as IDBOpenDBRequest;
  });
  return { indexedDb: { deleteDatabase } as unknown as IDBFactory, deleteDatabase };
}

describe("hosted storage cleanup", () => {
  it("only recognizes the Styal-owned hosted app origin", () => {
    expect(isKnownStyalHostedOrigin("https://app.styal.build")).toBe(true);
    expect(isKnownStyalHostedOrigin("https://app.styal.build/pair")).toBe(true);
    expect(isKnownStyalHostedOrigin("http://app.styal.build")).toBe(false);
    expect(isKnownStyalHostedOrigin("http://localhost:5733")).toBe(false);
    expect(isKnownStyalHostedOrigin("https://styal.example.com")).toBe(false);
  });

  it("removes abandoned T3 Code keys and databases on the hosted origin", async () => {
    const storage = createStorage({
      "t3code:prompt-stash:v2": "large-prompt-stash",
      "t3code:ui-state:v1": "legacy-state",
      "styal:ui-state:v1": "current-state",
      unrelated: "keep-me",
    });
    const removeItem = vi.spyOn(storage, "removeItem");
    const { indexedDb, deleteDatabase } = createIndexedDb();

    await expect(
      cleanupAbandonedHostedStorage({
        origin: "https://app.styal.build",
        storage,
        indexedDb,
      }),
    ).resolves.toBe(true);

    expect(removeItem.mock.calls[0]).toEqual(["t3code:prompt-stash:v2"]);
    expect(storage.getItem("t3code:prompt-stash:v2")).toBeNull();
    expect(storage.getItem("t3code:ui-state:v1")).toBeNull();
    expect(storage.getItem("styal:ui-state:v1")).toBe("current-state");
    expect(storage.getItem("unrelated")).toBe("keep-me");
    expect(deleteDatabase.mock.calls).toEqual([
      ["t3code:connection-runtime"],
      ["t3code:cloud-auth"],
    ]);
  });

  it("does nothing on localhost and arbitrary self-hosted origins", async () => {
    for (const origin of ["http://localhost:5733", "https://code.example.com"]) {
      const storage = createStorage({ "t3code:prompt-stash:v2": "keep-me" });
      const { indexedDb, deleteDatabase } = createIndexedDb();

      await expect(cleanupAbandonedHostedStorage({ origin, storage, indexedDb })).resolves.toBe(
        false,
      );
      expect(storage.getItem("t3code:prompt-stash:v2")).toBe("keep-me");
      expect(deleteDatabase).not.toHaveBeenCalled();
    }
  });

  it("runs once after a successful cleanup", async () => {
    const storage = createStorage({ "t3code:ui-state:v1": "legacy-state" });
    const { indexedDb, deleteDatabase } = createIndexedDb();
    const input = { origin: "https://app.styal.build", storage, indexedDb };

    await expect(cleanupAbandonedHostedStorage(input)).resolves.toBe(true);
    await expect(cleanupAbandonedHostedStorage(input)).resolves.toBe(false);
    expect(deleteDatabase).toHaveBeenCalledTimes(2);
  });

  it("retries later when an IndexedDB deletion is blocked", async () => {
    const storage = createStorage({ "t3code:ui-state:v1": "legacy-state" });
    const { indexedDb } = createIndexedDb("blocked");

    await expect(
      cleanupAbandonedHostedStorage({
        origin: "https://app.styal.build",
        storage,
        indexedDb,
      }),
    ).resolves.toBe(false);

    const retry = createIndexedDb();
    await expect(
      cleanupAbandonedHostedStorage({
        origin: "https://app.styal.build",
        storage,
        indexedDb: retry.indexedDb,
      }),
    ).resolves.toBe(true);
    expect(retry.deleteDatabase).toHaveBeenCalledTimes(2);
  });
});
