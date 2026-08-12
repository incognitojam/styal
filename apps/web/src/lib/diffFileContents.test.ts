import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, ProjectId, type ReviewDiffFileContentsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGitDiffFileContentsLoader,
  createPullRequestImageDiffContentsLoader,
} from "./diffFileContents";

const SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  sourceKind: "branch-range" as const,
  baseRef: "main",
  headRef: "feature",
  cacheKey: "comparison-1",
};

const PULL_REQUEST_SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  reference: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 42 },
  commit: null,
  cacheKey: "pull-request-42",
} as const;

function fileDiff(type: FileDiffMetadata["type"] = "rename-changed"): FileDiffMetadata {
  return {
    type,
    prevName: "a/src/old-name.ts",
    name: "b/src/new-name.ts",
  } as FileDiffMetadata;
}

describe("createGitDiffFileContentsLoader", () => {
  it("loads both sides with normalized paths and comparison-scoped cache keys", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).resolves.toEqual({
      oldFile: {
        name: "src/old-name.ts",
        contents: "before\n",
        cacheKey: "comparison-1:old:src/old-name.ts",
      },
      newFile: {
        name: "src/new-name.ts",
        contents: "after\n",
        cacheKey: "comparison-1:new:src/new-name.ts",
      },
    });
    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace",
        sourceKind: "branch-range",
        changeType: "rename-changed",
        baseRef: "main",
        headRef: "feature",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });

  it("loads a pure rename from its one shared file", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "same\n", newContents: "same\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff("rename-pure"))).resolves.toMatchObject({
      oldFile: null,
      newFile: { name: "src/new-name.ts", contents: "same\n" },
    });
  });

  it("passes command failures through to Pierre's expansion handling", async () => {
    const failure = new Error("revision is not available locally");
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileContentsResult, Error>(Cause.fail(failure)),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).rejects.toBe(failure);
  });
});

describe("createPullRequestImageDiffContentsLoader", () => {
  it("requests image contents through the pull request file command", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({
        oldContents: "data:image/png;base64,YmVmb3Jl",
        newContents: "data:image/png;base64,YWZ0ZXI=",
      }),
    );
    const load = createPullRequestImageDiffContentsLoader(getDiffFileContents, PULL_REQUEST_SOURCE);

    await expect(load(fileDiff())).resolves.toEqual({
      oldImage: "data:image/png;base64,YmVmb3Jl",
      newImage: "data:image/png;base64,YWZ0ZXI=",
    });
    expect(getDiffFileContents).toHaveBeenCalledTimes(1);
    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        projectId: "project-1",
        repository: "acme/web",
        number: 42,
        format: "image",
        changeType: "rename-changed",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });
});
