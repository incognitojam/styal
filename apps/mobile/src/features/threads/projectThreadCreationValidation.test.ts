import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  resolveProjectThreadCreationBranch,
  validateProjectThreadCreation,
} from "./projectThreadCreationValidation";

describe("resolveProjectThreadCreationBranch", () => {
  it("uses the live checkout for an untouched local draft label and recorded branch", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("feature/x");
  });

  it("prefers an explicit picker choice over the current checkout", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: "main",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });

  it("stays null when no ref is checked out (detached HEAD, non-repository, status not loaded)", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: null,
      }),
    ).toBeNull();
  });

  it("never borrows the current checkout for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBeNull();
  });

  it("keeps the explicit base branch for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: "main",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });
});

describe("validateProjectThreadCreation", () => {
  const base = {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("project-1"),
    initialMessageText: "do the thing",
  };

  it("refuses a worktree draft when the repository has no commits", () => {
    const error = validateProjectThreadCreation({
      ...base,
      environmentMode: "worktree",
      // git names an unborn branch, so a base branch alone is not enough.
      branch: "main",
      worktreeUnavailable: true,
    });

    expect(error?._tag).toBe("ProjectThreadFirstCommitRequiredError");
    expect(error?.message).toContain("no commits yet");
  });

  it("allows a local draft in a repository with no commits", () => {
    expect(
      validateProjectThreadCreation({
        ...base,
        environmentMode: "local",
        branch: "main",
        worktreeUnavailable: true,
      }),
    ).toBeNull();
  });

  it("allows a worktree draft when the field is absent, as on older servers", () => {
    expect(
      validateProjectThreadCreation({
        ...base,
        environmentMode: "worktree",
        branch: "main",
      }),
    ).toBeNull();
  });
});
