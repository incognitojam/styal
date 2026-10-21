import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  addProjectDefaultRepositoryChoices,
  findExistingAddProject,
  getAddProjectInitialQuery,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  normalizePastedCloneUrl,
  repositoryOwnerAvatarUrl,
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

describe("default repository choices when adding a checkout", () => {
  const remote = (remoteName: string, url: string, nameWithOwner: string | null = null) => ({
    remoteName,
    url,
    nameWithOwner,
    provider: SourceControlProviderKind.make(url.includes("github") ? "github" : "gitlab"),
  });
  const fork = remote("origin", "git@github.com:octocat/t3code.git", "octocat/t3code");
  const parent = remote("upstream", "https://github.com/pingdotgg/t3code", "pingdotgg/t3code");

  it("offers each GitHub repository once, in the order gh ranks their remotes", () => {
    expect(
      addProjectDefaultRepositoryChoices({ remotes: [fork, parent], defaultRemoteName: null }),
    ).toEqual([parent, fork]);
    // A second remote for the fork collapses into the remote gh ranks higher.
    const forkAgain = remote("mine", "https://github.com/OctoCat/t3code.git", "OctoCat/t3code");
    expect(
      addProjectDefaultRepositoryChoices({
        remotes: [forkAgain, fork, parent],
        defaultRemoteName: null,
      }),
    ).toEqual([parent, fork]);
  });

  it("asks nothing once a default is set or only one GitHub repository is named", () => {
    expect(
      addProjectDefaultRepositoryChoices({ remotes: [fork, parent], defaultRemoteName: "origin" }),
    ).toEqual([]);
    expect(
      addProjectDefaultRepositoryChoices({
        remotes: [fork, remote("backup", "https://github.com/octocat/t3code", "octocat/t3code")],
        defaultRemoteName: null,
      }),
    ).toEqual([]);
    expect(
      addProjectDefaultRepositoryChoices({
        remotes: [fork, remote("mirror", "git@gitlab.com:octocat/t3code.git", "octocat/t3code")],
        defaultRemoteName: null,
      }),
    ).toEqual([]);
    expect(
      addProjectDefaultRepositoryChoices({ remotes: [fork], defaultRemoteName: null }),
    ).toEqual([]);
  });
});

describe("add project shared logic", () => {
  it("prefers the configured directory over the server default", () => {
    expect(getAddProjectInitialQuery("", "~/Developer/")).toBe("~/Developer/");
    expect(getAddProjectInitialQuery("", "~/Developer")).toBe("~/Developer/");
    expect(getAddProjectInitialQuery("/work", "~/Developer/")).toBe("/work/");
    expect(getAddProjectInitialQuery("~", "~/Developer/")).toBe("~/");
    expect(getAddProjectInitialQuery("", null)).toBe("~/");
  });

  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
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
});
