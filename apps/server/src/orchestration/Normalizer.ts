import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES,
} from "@t3tools/contracts";

import {
  createAttachmentId,
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { inferImageExtension, parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>, attachmentsDir: string) {
    if (attachmentPaths.length === 0) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) =>
        fileSystem.remove(attachmentPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              attachmentPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
    const attachmentDirectories = [
      ...new Set(
        attachmentPaths
          .map((attachmentPath) => path.dirname(attachmentPath))
          .filter((directory) => directory !== attachmentsDir),
      ),
    ];
    yield* Effect.forEach(
      attachmentDirectories,
      (directory) =>
        fileSystem.remove(directory, { recursive: true, force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment directory.", {
              directory,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    const claimedAttachmentPaths: string[] = [];
    const preparedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!("dataUrl" in attachment)) {
            const claim = planAttachmentClaim({
              attachmentsDir: serverConfig.attachmentsDir,
              threadId: canonicalCommand.threadId,
              attachment,
            });
            if (!claim.ok) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
              });
            }

            const info = yield* fileSystem.stat(claim.currentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                    cause,
                  }),
              ),
            );
            if (Number(info.size) !== attachment.sizeBytes) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
              });
            }
            if (
              attachment.type === "image" &&
              path.extname(claim.currentPath).toLowerCase() !==
                inferImageExtension({
                  mimeType: attachment.mimeType,
                  fileName: attachment.name,
                })
            ) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: image type does not match the upload.`,
              });
            }

            const normalizedAttachment = {
              ...attachment,
              id: claim.finalId,
              mimeType: attachment.mimeType.toLowerCase(),
            };
            const maxBytes =
              attachment.type === "image"
                ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
            if (attachment.sizeBytes === 0 || attachment.sizeBytes > maxBytes) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' is empty or too large.`,
              });
            }

            return {
              kind: "pending" as const,
              attachment: normalizedAttachment,
              currentPath: claim.currentPath,
              finalPath: claim.finalPath,
              sizeBytes: attachment.sizeBytes,
            };
          }

          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || (attachment.type === "image" && !parsed.mimeType.startsWith("image/"))) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid ${attachment.type} attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          const maxBytes =
            attachment.type === "image"
              ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
              : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
          if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' is empty or too large.`,
            });
          }

          return {
            kind: "inline" as const,
            attachment,
            bytes,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };
        }),
      { concurrency: 1 },
    );

    const totalAttachmentBytes = preparedAttachments.reduce(
      (total, prepared) => total + prepared.sizeBytes,
      0,
    );
    if (totalAttachmentBytes > PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Attachments exceed the total size limit for one message.",
      });
    }

    const normalizedAttachments = yield* Effect.forEach(
      preparedAttachments,
      (prepared) =>
        Effect.gen(function* () {
          if (prepared.kind === "pending") {
            // Keep the pending upload until the turn succeeds. A failed thread
            // bootstrap can then retry with a fresh thread id.
            yield* fileSystem
              .makeDirectory(path.dirname(prepared.finalPath), { recursive: true })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationDispatchCommandError({
                      message: `Failed to create attachment directory for '${prepared.attachment.name}'.`,
                      cause,
                    }),
                ),
              );
            yield* fileSystem.copyFile(prepared.currentPath, prepared.finalPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to claim attachment '${prepared.attachment.name}' for this thread.`,
                    cause,
                  }),
              ),
            );
            claimedAttachmentPaths.push(prepared.finalPath);
            return prepared.attachment;
          }

          const { attachment, bytes, mimeType } = prepared;
          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: attachment.type,
            id: attachmentId,
            name: attachment.name,
            mimeType,
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.tapError(() =>
        removeClaimedAttachmentPaths(claimedAttachmentPaths, serverConfig.attachmentsDir),
      ),
    );

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  if (command.type !== "thread.turn.start" || normalizedCommand.type !== "thread.turn.start") {
    return;
  }

  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];
  for (const [index, attachment] of normalizedCommand.message.attachments.entries()) {
    const original = command.message.attachments[index];
    if (
      !original ||
      "dataUrl" in original ||
      parseThreadSegmentFromAttachmentId(original.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      continue;
    }

    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (claimedPath) {
      claimedPaths.push(claimedPath);
    }
  }
  yield* removeClaimedAttachmentPaths(claimedPaths, serverConfig.attachmentsDir);
});
