import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "../../lib/scopedEntities";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import { makeThreadShellFixture } from "../../test-fixtures";
import type { IncomingShareDraft } from "./incoming-share-model";
import {
  importIncomingShareIntoThread,
  RECENT_SHARE_THREAD_LIMIT,
  shareThreadTargets,
} from "./incoming-share-thread";

const environmentId = EnvironmentId.make("local");

function makeProject(id: string, title: string, archivedAt: string | null = null) {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt,
  } satisfies EnvironmentProject;
}

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "projectId">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    title: `Thread ${input.id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  });
}

function image(id: string): DraftComposerAttachment {
  return {
    id,
    type: "image",
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
    previewUri: `file:///attachments/${id}.png`,
    fileUri: `file:///attachments/${id}.png`,
  };
}

function makeShare(attachments: ReadonlyArray<DraftComposerAttachment>): IncomingShareDraft {
  return {
    schemaVersion: 1,
    id: "share-1",
    createdAt: "2026-06-02T00:00:00.000Z",
    text: "The sidebar overlaps the composer",
    attachments,
    warnings: [],
  };
}

describe("share thread targets", () => {
  const styal = makeProject("styal", "styal");
  const archived = makeProject("old", "Old project", "2026-06-01T00:00:00.000Z");

  it("lists the most recently used threads first, skipping archived ones", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("a"),
        projectId: styal.id,
        updatedAt: "2026-06-03T00:00:00Z",
      }),
      makeThread({
        id: ThreadId.make("b"),
        projectId: styal.id,
        updatedAt: "2026-06-01T00:00:00Z",
        latestUserMessageAt: "2026-06-05T00:00:00Z",
      }),
      makeThread({
        id: ThreadId.make("archived-thread"),
        projectId: styal.id,
        updatedAt: "2026-06-09T00:00:00Z",
        archivedAt: "2026-06-09T00:00:00Z",
      }),
      makeThread({
        id: ThreadId.make("archived-project"),
        projectId: archived.id,
        updatedAt: "2026-06-09T00:00:00Z",
      }),
    ];

    const targets = shareThreadTargets({ threads, projects: [styal, archived], searchText: "" });

    expect(targets.map((target) => target.thread.id)).toEqual(["b", "a"]);
    expect(targets[0]?.project.title).toBe("styal");
  });

  it("shows a few recent threads, and searches all of them by thread or project title", () => {
    const other = makeProject("docs", "Docs site");
    const threads = [
      ...Array.from({ length: 8 }, (_, index) =>
        makeThread({
          id: ThreadId.make(`t${index}`),
          projectId: styal.id,
          updatedAt: `2026-06-0${index + 1}T00:00:00Z`,
        }),
      ),
      makeThread({
        id: ThreadId.make("feedback"),
        projectId: styal.id,
        title: "Composer feedback",
        updatedAt: "2026-05-01T00:00:00Z",
      }),
      makeThread({
        id: ThreadId.make("docs"),
        projectId: other.id,
        updatedAt: "2026-05-01T00:00:00Z",
      }),
    ];
    const projects = [styal, other];

    expect(shareThreadTargets({ threads, projects, searchText: "" })).toHaveLength(
      RECENT_SHARE_THREAD_LIMIT,
    );
    expect(
      shareThreadTargets({ threads, projects, searchText: " FEEDBACK " }).map((t) => t.thread.id),
    ).toEqual(["feedback"]);
    expect(
      shareThreadTargets({ threads, projects, searchText: "docs" }).map((t) => t.thread.id),
    ).toEqual(["docs"]);
  });
});

describe("importing a share into a thread", () => {
  const thread = { environmentId, id: ThreadId.make("thread-1") };
  const draftKey = scopedThreadKey(environmentId, thread.id);

  it("writes the thread draft before consuming the share and releases unused files", async () => {
    const calls: string[] = [];
    const kept = image("kept");
    const dropped = image("dropped");
    const releaseUnusedAttachments = vi.fn();
    const mergeDraft = vi.fn(async () => {
      calls.push("merge");
      return { skippedAttachmentCount: 1 };
    });

    const result = await importIncomingShareIntoThread(makeShare([kept, dropped]), thread, {
      serverConfig: null,
      mergeDraft,
      draftAttachmentIds: () => new Set([kept.id]),
      consumeShare: async () => {
        calls.push("consume");
      },
      releaseUnusedAttachments,
    });

    expect(calls).toEqual(["merge", "consume"]);
    expect(mergeDraft).toHaveBeenCalledWith(draftKey, {
      text: "The sidebar overlaps the composer",
      attachments: [kept, dropped],
      sourceShareId: "share-1",
    });
    expect(releaseUnusedAttachments).toHaveBeenCalledWith([dropped]);
    expect(result.warnings).toEqual([
      "1 shared file was skipped because this draft reached the attachment limit.",
    ]);
  });

  it("keeps the share in the inbox when the draft write fails", async () => {
    const consumeShare = vi.fn(async () => {});

    await expect(
      importIncomingShareIntoThread(makeShare([image("a")]), thread, {
        serverConfig: null,
        mergeDraft: async () => {
          throw new Error("disk full");
        },
        draftAttachmentIds: () => new Set(),
        consumeShare,
        releaseUnusedAttachments: () => {},
      }),
    ).rejects.toThrow("disk full");
    expect(consumeShare).not.toHaveBeenCalled();
  });
});
