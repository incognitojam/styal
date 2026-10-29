import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import {
  selectIncomingShareAttachmentsForServer,
  type IncomingShareDraft,
} from "./incoming-share-model";

export const RECENT_SHARE_THREAD_LIMIT = 5;
const SEARCHED_SHARE_THREAD_LIMIT = 20;

export interface ShareThreadTarget {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
}

/**
 * Threads a share can be added to, most recently used first. Threads in
 * archived projects stay out, as they do in the thread list.
 */
export function shareThreadTargets(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly searchText: string;
}): ReadonlyArray<ShareThreadTarget> {
  const projectsByKey = new Map(
    input.projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project]),
  );
  const query = input.searchText.trim().toLowerCase();
  const targets: ShareThreadTarget[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const project = projectsByKey.get(scopedProjectKey(thread.environmentId, thread.projectId));
    if (!project || project.archivedAt) continue;
    const title = thread.title || "Untitled thread";
    if (
      query &&
      !title.toLowerCase().includes(query) &&
      !project.title.toLowerCase().includes(query)
    ) {
      continue;
    }
    targets.push({ thread, project });
  }
  targets.sort((left, right) =>
    (right.thread.latestUserMessageAt ?? right.thread.updatedAt).localeCompare(
      left.thread.latestUserMessageAt ?? left.thread.updatedAt,
    ),
  );
  return targets.slice(0, query ? SEARCHED_SHARE_THREAD_LIMIT : RECENT_SHARE_THREAD_LIMIT);
}

type ServerConfigForShare = Parameters<
  typeof selectIncomingShareAttachmentsForServer
>[0]["serverConfig"];

export interface ImportShareIntoThreadDependencies {
  readonly serverConfig: ServerConfigForShare;
  readonly mergeDraft: (
    draftKey: string,
    content: {
      readonly text: string;
      readonly attachments: ReadonlyArray<DraftComposerAttachment>;
      readonly sourceShareId: string;
    },
  ) => Promise<{ readonly skippedAttachmentCount: number }>;
  readonly draftAttachmentIds: (draftKey: string) => ReadonlySet<string>;
  readonly consumeShare: (shareId: string) => Promise<void>;
  readonly releaseUnusedAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
}

/**
 * Adds a share to an existing thread's composer draft. The draft write lands
 * before the inbox entry is consumed, and the draft's import receipt makes a
 * retry after an interruption a no-op instead of a duplicate.
 */
export async function importIncomingShareIntoThread(
  share: IncomingShareDraft,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
  deps: ImportShareIntoThreadDependencies,
): Promise<{ readonly warnings: ReadonlyArray<string> }> {
  const selected = selectIncomingShareAttachmentsForServer({
    attachments: share.attachments,
    serverConfig: deps.serverConfig,
  });
  if (selected.status === "pending") {
    throw new Error("Server attachment support is still loading.");
  }
  const draftKey = scopedThreadKey(thread.environmentId, thread.id);
  const { skippedAttachmentCount } = await deps.mergeDraft(draftKey, {
    text: share.text,
    attachments: selected.attachments,
    sourceShareId: share.id,
  });
  await deps.consumeShare(share.id);
  // The consumed inbox entry was the last owner of files that did not make it
  // into the draft.
  const retained = deps.draftAttachmentIds(draftKey);
  deps.releaseUnusedAttachments(
    share.attachments.filter((attachment) => !retained.has(attachment.id)),
  );
  const warnings = [...share.warnings, ...selected.warnings];
  if (skippedAttachmentCount > 0) {
    warnings.push(
      `${skippedAttachmentCount} shared file${skippedAttachmentCount === 1 ? " was" : "s were"} skipped because this draft reached the attachment limit.`,
    );
  }
  return { warnings };
}
