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
  canCreateProjectInEnvironment,
  findExistingAddProject,
  getAddProjectInitialQuery,
  getCloneDestinationQuery,
  resolveAddProjectPath,
  sortAddProjectProviderSources,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

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

  it("appends the repository directory name to the clone destination", () => {
    expect(
      getCloneDestinationQuery({
        parentPath: "~/projects/",
        nameWithOwner: "yngatech/t3code",
        remoteUrl: "git@github.com:yngatech/t3code.git",
      }),
    ).toBe("~/projects/t3code");
    expect(
      getCloneDestinationQuery({
        parentPath: "C:\\work\\",
        nameWithOwner: "org/team/repo",
        remoteUrl: "https://dev.azure.com/org/team/_git/repo",
      }),
    ).toBe("C:\\work\\repo");
  });

  it("derives the clone directory name from the remote url alone", () => {
    const fromUrl = (remoteUrl: string) =>
      getCloneDestinationQuery({ parentPath: "/work/", remoteUrl });
    expect(fromUrl("git@github.com:owner/repo.git")).toBe("/work/repo");
    expect(fromUrl("https://gitlab.com/group/sub/repo.git")).toBe("/work/repo");
    expect(fromUrl("ssh://git@example.com:2222/owner/repo")).toBe("/work/repo");
    expect(fromUrl("https://example.com/owner/repo/")).toBe("/work/repo");
    expect(fromUrl("/srv/git/repo.git")).toBe("/work/repo");
  });

  it("keeps the parent path when no directory name can be derived", () => {
    expect(getCloneDestinationQuery({ parentPath: "~/projects/", remoteUrl: "  " })).toBe(
      "~/projects/",
    );
    expect(getCloneDestinationQuery({ parentPath: "~/projects/", remoteUrl: "../" })).toBe(
      "~/projects/",
    );
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
});
