import { ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  commandFileCandidates,
  projectFileApprovalKey,
  splitCommandWords,
} from "./projectFileApprovals.ts";

const id = ProjectId.make("project-1");
const identity = (overrides: Partial<RepositoryIdentity> = {}): RepositoryIdentity => ({
  canonicalKey: "github.com/acme/widgets",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/widgets.git",
  },
  rootPath: "/src/widgets",
  ...overrides,
});

describe("projectFileApprovalKey", () => {
  it("keys a repository-root project by its repository", () => {
    expect(
      projectFileApprovalKey({ id, workspaceRoot: "/src/widgets", repositoryIdentity: identity() }),
    ).toBe("github.com/acme/widgets");
  });

  it("separates monorepo projects by their path in the repository", () => {
    expect(
      projectFileApprovalKey({
        id,
        workspaceRoot: "/src/widgets/apps/web",
        repositoryIdentity: identity(),
      }),
    ).toBe("github.com/acme/widgets::apps/web");
  });

  it("prefers a fork's own remote so it never shares upstream's approvals", () => {
    expect(
      projectFileApprovalKey({
        id,
        workspaceRoot: "/src/widgets",
        repositoryIdentity: identity({
          origin: { canonicalKey: "github.com/me/widgets" },
        }),
      }),
    ).toBe("github.com/me/widgets");
  });

  it("falls back to the project without a known repository", () => {
    expect(
      projectFileApprovalKey({ id, workspaceRoot: "/tmp/scratch", repositoryIdentity: null }),
    ).toBe("project:project-1");
  });
});

describe("commandFileCandidates", () => {
  it("splits on whitespace and shell separators, honouring quotes", () => {
    expect(splitCommandWords(`bash "scripts/my setup.sh" && echo 'done now'`)).toEqual([
      "bash",
      "scripts/my setup.sh",
      "echo",
      "done now",
    ]);
  });

  it("finds relative paths and interpreter arguments", () => {
    expect(commandFileCandidates("./scripts/setup.sh --fast").paths).toEqual(["scripts/setup.sh"]);
    expect(commandFileCandidates("bash setup.sh").paths).toEqual(["setup.sh"]);
    expect(commandFileCandidates("node tools/bootstrap.mjs").paths).toEqual([
      "tools/bootstrap.mjs",
    ]);
  });

  it("ignores absolute, home, parent and variable paths", () => {
    expect(
      commandFileCandidates('/usr/bin/env ~/x.sh ../up.sh "$STYAL_PROJECT_ROOT/.env"').paths,
    ).toEqual([]);
  });

  it("names package-manager scripts but not built-in subcommands", () => {
    expect(commandFileCandidates("pnpm run setup").packageScripts).toEqual(["setup"]);
    expect(commandFileCandidates("vp run dev:all").packageScripts).toEqual(["dev:all"]);
    expect(commandFileCandidates("bun bootstrap").packageScripts).toEqual(["bootstrap"]);
    expect(commandFileCandidates("pnpm install && vp i").packageScripts).toEqual([]);
  });
});
