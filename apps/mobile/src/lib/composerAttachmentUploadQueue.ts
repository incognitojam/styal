import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";

import { parseLegacyNewTaskDraftKey } from "../state/new-task-draft-key";
import type { DraftComposerAttachment } from "./composerImages";

export interface ComposerAttachmentUploadRequest {
  readonly environmentId: EnvironmentId;
  readonly attachment: DraftComposerAttachment;
}

export type ComposerAttachmentUploadState =
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly reason: string };

export function composerAttachmentUploadKey(
  environmentId: EnvironmentId,
  attachmentId: string,
): string {
  return `${environmentId}:${attachmentId}`;
}

export function composerDraftEnvironmentId(
  draftKey: string,
  queuedMessages: ReadonlyArray<{
    readonly messageId: string;
    readonly environmentId: EnvironmentId;
  }>,
  draft?: { readonly project?: { readonly environmentId: EnvironmentId } },
): EnvironmentId | null {
  if (draftKey.startsWith("pending-task:")) {
    return (
      queuedMessages.find((message) => `pending-task:${message.messageId}` === draftKey)
        ?.environmentId ?? null
    );
  }
  if (draftKey.startsWith("new-task:")) {
    if (draft?.project) {
      return draft.project.environmentId;
    }
    const legacy = parseLegacyNewTaskDraftKey(draftKey);
    return legacy === null ? null : EnvironmentId.make(legacy.environmentId);
  }
  const separator = draftKey.lastIndexOf(":");
  return separator > 0 ? EnvironmentId.make(draftKey.slice(0, separator)) : null;
}

type UploadServerConfig = {
  readonly environment: {
    readonly capabilities: Pick<
      ServerConfig["environment"]["capabilities"],
      "attachmentUploads" | "fileAttachments"
    >;
  };
};

export function canUploadComposerAttachment(
  attachment: DraftComposerAttachment,
  config: UploadServerConfig | null | undefined,
): boolean {
  const capabilities = config?.environment.capabilities;
  return (
    capabilities?.attachmentUploads === true &&
    (attachment.type === "image" ||
      (capabilities.fileAttachments !== undefined &&
        attachment.sizeBytes <=
          clampFileAttachmentUploadBytes(capabilities.fileAttachments.maxUploadBytes)))
  );
}

export function composerAttachmentUploadBlockReason(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly connected: boolean;
  readonly serverConfig: UploadServerConfig | null;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): string | null {
  if (!input.connected) return null;
  for (const attachment of input.attachments) {
    if (!canUploadComposerAttachment(attachment, input.serverConfig)) continue;
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)];
    if (state?.status === "failed") return "Retry or remove the failed attachment";
  }
  return null;
}

export function composerAttachmentsStillUploading(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly serverConfig: UploadServerConfig | null;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): boolean {
  return input.attachments.some((attachment) => {
    if (!canUploadComposerAttachment(attachment, input.serverConfig)) return false;
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)];
    return state?.status !== "ready" && state?.status !== "failed";
  });
}

/**
 * A connection that drops and recovers before the worker sees it disconnect never removes the
 * request, so the queue must retry a connection failure itself instead of waiting for a tap.
 */
const CONNECTION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export function createComposerAttachmentUploadQueue(options: {
  readonly upload: (
    request: ComposerAttachmentUploadRequest,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ) => Promise<boolean>;
  readonly onChange: (states: Readonly<Record<string, ComposerAttachmentUploadState>>) => void;
  readonly isConnectionFailure: (error: unknown) => boolean;
}) {
  const jobs = new Map<
    string,
    { readonly controller: AbortController; readonly done: Promise<void> }
  >();
  type ConnectionRetry = {
    readonly attempt: number;
    timer: ReturnType<typeof setTimeout> | null;
  };
  const connectionRetries = new Map<string, ConnectionRetry>();
  let desired = new Map<string, ComposerAttachmentUploadRequest>();
  let states: Readonly<Record<string, ComposerAttachmentUploadState>> = {};
  let disposed = false;

  function setState(key: string, state: ComposerAttachmentUploadState | undefined) {
    const previous = states[key];
    if (
      previous === state ||
      (previous?.status === "uploading" &&
        state?.status === "uploading" &&
        previous.progress === state.progress)
    )
      return;
    const next = { ...states };
    if (state) next[key] = state;
    else delete next[key];
    states = next;
    options.onChange(states);
  }

  function clearConnectionRetry(key: string) {
    const retry = connectionRetries.get(key);
    if (retry?.timer) clearTimeout(retry.timer);
    connectionRetries.delete(key);
  }

  function pump() {
    if (disposed) return;
    for (const [key, request] of desired) {
      if (jobs.size >= 3) break;
      if (
        jobs.has(key) ||
        connectionRetries.get(key)?.timer ||
        states[key]?.status === "ready" ||
        states[key]?.status === "failed"
      )
        continue;
      const controller = new AbortController();
      setState(key, { status: "uploading", progress: 0 });
      // Publish the job before starting async work, including synchronous test transports.
      const done = Promise.resolve()
        .then(() =>
          options.upload(request, controller.signal, (progress) => {
            if (controller.signal.aborted) return;
            setState(key, {
              status: "uploading",
              progress: Math.floor(Math.max(0, Math.min(1, progress)) * 20) / 20,
            });
          }),
        )
        .then((persisted) => {
          if (!controller.signal.aborted && desired.has(key)) {
            clearConnectionRetry(key);
            if (!persisted) desired.delete(key);
            setState(key, persisted ? { status: "ready" } : undefined);
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted && desired.has(key)) {
            const attempt = connectionRetries.get(key)?.attempt ?? 0;
            const delay = CONNECTION_RETRY_DELAYS_MS[attempt];
            if (delay !== undefined && options.isConnectionFailure(error)) {
              const retry: ConnectionRetry = {
                attempt: attempt + 1,
                timer: setTimeout(() => {
                  retry.timer = null;
                  pump();
                }, delay),
              };
              connectionRetries.set(key, retry);
              setState(key, { status: "uploading", progress: 0 });
              return;
            }
            clearConnectionRetry(key);
            setState(key, {
              status: "failed",
              reason: error instanceof Error ? error.message : "Upload failed. Tap to retry.",
            });
          }
        })
        .finally(() => {
          jobs.delete(key);
          pump();
        });
      jobs.set(key, { controller, done });
    }
  }

  return {
    sync(requests: ReadonlyArray<ComposerAttachmentUploadRequest>) {
      if (disposed) return;
      desired = new Map(
        requests.map((request) => [
          composerAttachmentUploadKey(request.environmentId, request.attachment.id),
          request,
        ]),
      );
      for (const [key, job] of jobs) {
        if (!desired.has(key)) job.controller.abort();
      }
      for (const key of connectionRetries.keys()) {
        if (!desired.has(key)) clearConnectionRetry(key);
      }
      for (const key of Object.keys(states)) {
        if (!desired.has(key)) setState(key, undefined);
      }
      for (const key of desired.keys()) {
        if (!states[key]) setState(key, { status: "uploading", progress: 0 });
      }
      pump();
    },
    retry(environmentId: EnvironmentId, attachmentId: string) {
      const key = composerAttachmentUploadKey(environmentId, attachmentId);
      if (states[key]?.status !== "failed") return;
      setState(key, undefined);
      pump();
    },
    async settled() {
      while (jobs.size > 0) await Promise.all([...jobs.values()].map((job) => job.done));
    },
    dispose() {
      disposed = true;
      desired.clear();
      for (const key of connectionRetries.keys()) clearConnectionRetry(key);
      for (const job of jobs.values()) job.controller.abort();
      states = {};
      options.onChange(states);
    },
  };
}
