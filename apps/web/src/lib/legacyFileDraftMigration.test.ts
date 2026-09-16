import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

const transfers = vi.hoisted(() => ({
  start: vi.fn(),
  wait: vi.fn<() => Promise<void>>(),
  read: vi.fn(),
  release: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("./attachmentUploadQueue", () => ({
  startAttachmentUpload: transfers.start,
  awaitAttachmentUploads: transfers.wait,
  readAttachmentUpload: transfers.read,
  releaseAttachmentUpload: transfers.release,
  forgetCompletedAttachmentUpload: transfers.forget,
}));

const environmentId = EnvironmentId.make("migration-environment");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("migration-thread"));
const threadKey = scopedThreadKey(threadRef);
const legacyFile = {
  type: "file" as const,
  id: "legacy-file",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  dataUrl: "data:text/plain;base64,aGVsbG8=",
};
const legacyStash = {
  id: "legacy-stash",
  prompt: "Review these notes",
  createdAt: "2026-09-01T12:00:00.000Z",
  attachments: [legacyFile],
  droppedImageNames: [],
};
let saved: Map<string, string>;
let rejectWrites = false;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  saved = new Map();
  rejectWrites = false;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (rejectWrites) throw new Error("storage unavailable");
      saved.set(key, value);
    },
    removeItem: (key: string) => saved.delete(key),
  });
  transfers.wait.mockResolvedValue();
  transfers.read.mockReturnValue({
    status: "ready",
    environmentId,
    attachmentId: "pending-migrated",
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("legacy web attachment migration", () => {
  it("confirms draft durability before releasing a stash owner", async () => {
    const { useComposerDraftStore, persistComposerDraftsNow } =
      await import("../composerDraftStore");
    useComposerDraftStore.getState().setPrompt(threadRef, "Saved destination");
    rejectWrites = true;
    expect(persistComposerDraftsNow()).toBe(false);
    rejectWrites = false;
    expect(persistComposerDraftsNow()).toBe(true);
    expect(
      JSON.parse(saved.get("styal:composer-drafts:v1")!).state.draftsByThreadKey[threadKey].prompt,
    ).toBe("Saved destination");
  });

  it("retains draft bytes offline and after a rejected reference write, then migrates on a durable retry", async () => {
    const key = "styal:composer-drafts:v1";
    saved.set(
      key,
      JSON.stringify({
        version: 8,
        state: {
          draftsByThreadKey: { [threadKey]: { prompt: "Saved notes", attachments: [legacyFile] } },
        },
      }),
    );
    const { useComposerDraftStore } = await import("../composerDraftStore");
    const store = useComposerDraftStore.getState();
    expect(await store.getComposerDraft(threadRef)?.files[0]?.file?.text()).toBe("hello");

    // Normal image persistence must not clear the legacy generic-file source.
    store.syncPersistedAttachments(threadRef, []);
    await Promise.resolve();
    expect(JSON.parse(saved.get(key)!).state.draftsByThreadKey[threadKey].attachments).toEqual([
      legacyFile,
    ]);

    rejectWrites = true;
    store.setFileUpload(threadRef, legacyFile.id, environmentId, "pending-migrated");
    store.syncPersistedAttachments(threadRef, []);
    await Promise.resolve();
    expect(JSON.parse(saved.get(key)!).state.draftsByThreadKey[threadKey].attachments).toEqual([
      legacyFile,
    ]);
    expect(await store.getComposerDraft(threadRef)?.files[0]?.file?.text()).toBe("hello");

    rejectWrites = false;
    store.syncPersistedAttachments(threadRef, []);
    await Promise.resolve();
    const persisted = JSON.parse(saved.get(key)!).state.draftsByThreadKey[threadKey];
    expect(persisted.attachments).toEqual([]);
    expect(persisted.files).toEqual([
      {
        id: legacyFile.id,
        name: legacyFile.name,
        mimeType: legacyFile.mimeType,
        sizeBytes: legacyFile.sizeBytes,
        attachmentId: "pending-migrated",
        environmentId,
      },
    ]);
    expect(JSON.stringify(persisted)).not.toContain("dataUrl");
  });

  it.each(["upload", "storage"] as const)(
    "keeps the original stash if %s fails",
    async (failure) => {
      const key = "styal:prompt-stash:v2";
      const original = JSON.stringify({ version: 2, state: { entries: [legacyStash] } });
      saved.set(key, original);
      const { migrateLegacyStashFiles } = await import("./legacyStashFiles");
      const { usePromptStashStore } = await import("../promptStashStore");
      if (failure === "upload") transfers.read.mockReturnValue({ status: "failed", environmentId });
      else rejectWrites = true;

      await expect(migrateLegacyStashFiles(legacyStash.id, environmentId)).rejects.toThrow();
      expect(saved.get(key)).toBe(original);
      expect(usePromptStashStore.getState().entries[0]?.attachments).toEqual([legacyFile]);
      expect(transfers.release).toHaveBeenCalledTimes(1);
      expect(transfers.forget).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy stash bytes through the upload, then atomically transfers ownership to its reference", async () => {
    const key = "styal:prompt-stash:v2";
    saved.set(key, JSON.stringify({ version: 2, state: { entries: [legacyStash] } }));
    const { migrateLegacyStashFiles } = await import("./legacyStashFiles");
    let finishUpload!: () => void;
    transfers.wait.mockReturnValue(
      new Promise<void>((resolve) => {
        finishUpload = resolve;
      }),
    );
    const migration = migrateLegacyStashFiles(legacyStash.id, environmentId);
    const repeated = migrateLegacyStashFiles(legacyStash.id, environmentId);
    expect(repeated).toBe(migration);
    expect(transfers.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(saved.get(key)!).state.entries[0].attachments).toEqual([legacyFile]);
    finishUpload();
    await migration;

    const entry = JSON.parse(saved.get(key)!).state.entries[0];
    expect(entry.prompt).toBe(legacyStash.prompt);
    expect(entry.attachments).toEqual([]);
    expect(entry.files).toEqual([
      {
        id: legacyFile.id,
        name: legacyFile.name,
        mimeType: legacyFile.mimeType,
        sizeBytes: legacyFile.sizeBytes,
        attachmentId: "pending-migrated",
        environmentId,
      },
    ]);
    expect(transfers.forget).toHaveBeenCalledTimes(1);
    expect(transfers.release).not.toHaveBeenCalled();
  });
});
