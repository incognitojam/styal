import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  CommandId,
  SourceControlDiscoveryResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  buildAddProjectRemoteSourceReadiness,
  buildProjectCreateCommand,
  buildWorkspaceDefaultPath,
  canCreateProjectInEnvironment,
  deriveWorkspaceFolderName,
  findExistingAddProject,
  getAddProjectInitialQuery,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  repositoryOwnerAvatarUrl,
  resolveAddProjectPath,
  sortAddProjectProviderSources,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("repository owner avatars", () => {
  it("derives an owner avatar from either transport of a GitHub remote", () => {
    expect(
      repositoryOwnerAvatarUrl({
        repositoryUrl: "https://github.com/commaai/openpilot",
        nameWithOwner: "commaai/openpilot",
      }),
    ).toBe("https://github.com/commaai.png?size=64");
    expect(
      repositoryOwnerAvatarUrl({
        repositoryUrl: "git@github.com:commaai/openpilot.git",
        nameWithOwner: "commaai/openpilot",
        size: 96,
      }),
    ).toBe("https://github.com/commaai.png?size=96");
  });

  it("keeps GitHub Enterprise hosts", () => {
    expect(
      repositoryOwnerAvatarUrl({
        repositoryUrl: "https://github.example.com/team/service",
        nameWithOwner: "team/service",
      }),
    ).toBe("https://github.example.com/team.png?size=64");
  });

  it("returns null where no avatar path exists, rather than sending clients after a 404", () => {
    expect(
      repositoryOwnerAvatarUrl({
        repositoryUrl: "https://gitlab.com/group/project",
        nameWithOwner: "group/project",
      }),
    ).toBeNull();
    expect(
      repositoryOwnerAvatarUrl({ repositoryUrl: "not a url", nameWithOwner: "owner/repo" }),
    ).toBeNull();
    expect(
      repositoryOwnerAvatarUrl({
        repositoryUrl: "https://github.com/commaai/openpilot",
        nameWithOwner: "",
      }),
    ).toBeNull();
  });
});

describe("add project shared logic", () => {
  it("only allows project creation in connected environments", () => {
    expect(canCreateProjectInEnvironment("connected")).toBe(true);
    expect(canCreateProjectInEnvironment("available")).toBe(false);
    expect(canCreateProjectInEnvironment("offline")).toBe(false);
    expect(canCreateProjectInEnvironment("connecting")).toBe(false);
    expect(canCreateProjectInEnvironment("reconnecting")).toBe(false);
    expect(canCreateProjectInEnvironment("error")).toBe(false);
  });

  it("resolves initial browse paths from settings", () => {
    expect(getAddProjectInitialQuery("")).toBe("~/");
    expect(getAddProjectInitialQuery("/work")).toBe("/work/");
    expect(getAddProjectInitialQuery("C:\\work")).toBe("C:\\work\\");
  });

  it("derives the clone folder name from the repository name with owner", () => {
    expect(getCloneDirectoryName("owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("org/project/repo")).toBe("repo");
    expect(getCloneDirectoryName("repo")).toBe("repo");
    expect(getCloneDirectoryName("owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("")).toBe("");
    expect(getCloneDirectoryName(null)).toBe("");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("proposes no clone folder for a link that names no repository", () => {
    expect(getCloneDirectoryName("https://github.com/")).toBe("");
    expect(getCloneDirectoryName("https://github.com")).toBe("");
    expect(getCloneDirectoryName("git@github.com:")).toBe("");
    expect(getCloneDirectoryName("ssh://git@github.com:22")).toBe("");
    expect(getCloneDirectoryName("https://")).toBe("");
  });

  it("proposes the clone destination inside the selected directory", () => {
    expect(getCloneDestinationPath("~/Projects/", "repo")).toBe("~/Projects/repo");
    expect(getCloneDestinationPath("~/Projects", "repo")).toBe("~/Projects/repo");
    expect(getCloneDestinationPath("C:\\work\\", "repo")).toBe("C:\\work\\repo");
    expect(getCloneDestinationPath("~/Projects/", null)).toBe("~/Projects/");
    expect(getCloneDestinationPath("~/Projects/", "")).toBe("~/Projects/");
  });

  it("keeps pinned clone destinations anchored to the browsed directory", () => {
    expect(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "~/Projects/",
        selectedDirectoryName: "work",
        cloneDirectoryName: "repo",
        caseSensitive: true,
      }),
    ).toBe("~/Projects/work/repo");
    expect(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "~/Projects/",
        selectedDirectoryName: "repo",
        cloneDirectoryName: "repo",
        caseSensitive: true,
      }),
    ).toBe("~/Projects/repo/");
    expect(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "C:\\Projects\\",
        selectedDirectoryName: "Repo",
        cloneDirectoryName: "repo",
        caseSensitive: false,
      }),
    ).toBe("C:\\Projects\\Repo\\");
  });

  it("rejects unsupported windows paths on non-windows environments", () => {
    expect(
      resolveAddProjectPath({
        rawPath: "C:\\repo",
        platform: "MacIntel",
        currentProjectCwd: null,
      }),
    ).toEqual({
      ok: false,
      error: "Windows-style paths are only supported on Windows environments.",
    });
  });

  it("resolves relative paths from the active project cwd", () => {
    expect(
      resolveAddProjectPath({
        rawPath: "../next",
        platform: "Linux",
        currentProjectCwd: "/work/current",
      }),
    ).toEqual({ ok: true, path: "/work/next" });
  });

  it("marks authenticated source control providers as ready", () => {
    const discovery: SourceControlDiscoveryResult = {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          status: "available",
          installHint: "Install gh",
          version: Option.some("1.0.0"),
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("octo"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "gitlab",
          label: "GitLab",
          status: "available",
          installHint: "Install glab",
          version: Option.some("1.0.0"),
          detail: Option.none(),
          auth: {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.some("Run glab auth login"),
          },
        },
      ],
    };

    const readiness = buildAddProjectRemoteSourceReadiness(discovery);
    expect(readiness.url.ready).toBe(true);
    expect(readiness.github.ready).toBe(true);
    expect(readiness.gitlab).toEqual({ ready: false, hint: "Run glab auth login" });
    expect(sortAddProjectProviderSources(readiness)[0]).toBe("github");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });

  it("builds the existing project.create command shape", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/work/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      type: "project.create",
      commandId: "command",
      projectId: "project",
      title: "repo",
      workspaceRoot: "/work/repo",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
    });
  });

  it("omits kind unless requested so older servers keep decoding", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/work/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).not.toHaveProperty("kind");
  });

  it("threads workspace kind and a title override into project.create", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/home/user/t3-workspaces/pc-maintenance",
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "workspace",
        title: "PC Maintenance",
      }),
    ).toMatchObject({
      type: "project.create",
      kind: "workspace",
      title: "PC Maintenance",
      workspaceRoot: "/home/user/t3-workspaces/pc-maintenance",
      createWorkspaceRootIfMissing: true,
    });
  });

  it("falls back to the inferred title when the override is blank", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/work/notes",
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "workspace",
        title: "   ",
      }).title,
    ).toBe("notes");
  });
});

describe("workspace paths", () => {
  it("slugs workspace names into portable folder names", () => {
    expect(deriveWorkspaceFolderName("PC Maintenance")).toBe("pc-maintenance");
    expect(deriveWorkspaceFolderName("  Planning / Docs  ")).toBe("planning-docs");
    expect(deriveWorkspaceFolderName("notes.2026")).toBe("notes.2026");
    expect(deriveWorkspaceFolderName("---")).toBe("workspace");
    expect(deriveWorkspaceFolderName("")).toBe("workspace");
  });

  it("builds a home-relative default path", () => {
    expect(buildWorkspaceDefaultPath("PC Maintenance")).toBe("~/t3-workspaces/pc-maintenance");
  });
});
