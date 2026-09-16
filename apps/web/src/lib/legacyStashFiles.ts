import type { EnvironmentId } from "@t3tools/contracts";
import { randomUUID } from "~/lib/utils";
import {
  hydrateAttachmentsFromPersisted,
  type ComposerFileAttachment,
} from "../composerDraftStore";
import { usePromptStashStore } from "../promptStashStore";
import {
  awaitAttachmentUploads,
  forgetCompletedAttachmentUpload,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "./attachmentUploadQueue";

const pendingMigrations = new Map<string, Promise<void>>();

/** Legacy stashes keep their bytes until the replacement references are durably saved. */
export function migrateLegacyStashFiles(
  entryId: string,
  environmentId: EnvironmentId,
): Promise<void> {
  const existing = pendingMigrations.get(entryId);
  if (existing) return existing;
  const migration = migrate(entryId, environmentId).finally(() =>
    pendingMigrations.delete(entryId),
  );
  pendingMigrations.set(entryId, migration);
  return migration;
}

async function migrate(entryId: string, environmentId: EnvironmentId): Promise<void> {
  const entry = usePromptStashStore
    .getState()
    .entries.find((candidate) => candidate.id === entryId);
  if (!entry) return;
  const legacyFiles = entry.attachments.filter((attachment) => attachment.type === "file");
  if (legacyFiles.length === 0) return;
  const files = hydrateAttachmentsFromPersisted(legacyFiles).filter(
    (attachment): attachment is ComposerFileAttachment => attachment.type === "file",
  );
  if (files.length !== legacyFiles.length)
    throw new Error("A saved file could not be read. The stash has been kept.");
  // Isolate these jobs from a draft or another stash that might share the original IDs.
  const uploads = files.map((file) => ({ ...file, id: randomUUID() }));
  let persisted = false;
  try {
    for (const image of uploads) startAttachmentUpload({ environmentId, image });
    await awaitAttachmentUploads(uploads.map((file) => file.id));
    const references = uploads.map((file, index) => {
      const upload = readAttachmentUpload(file.id);
      if (upload?.status !== "ready" || upload.environmentId !== environmentId) {
        throw new Error(
          "Reconnect and retry to restore these saved files. The stash has been kept.",
        );
      }
      return {
        id: files[index]!.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        attachmentId: upload.attachmentId,
        environmentId,
      };
    });
    persisted = usePromptStashStore.getState().migrateEntryFiles(entryId, references);
    if (!persisted)
      throw new Error(
        "The uploaded file references could not be saved. The original stash has been kept.",
      );
  } finally {
    for (const file of uploads) {
      if (persisted) forgetCompletedAttachmentUpload(file.id);
      else releaseAttachmentUpload(file.id);
    }
  }
}
