import type {
  DesktopPreviewAppBuild,
  DesktopPreviewAppState,
  PullRequestDetail,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  previewAppControlView,
  previewBuildIsRunning,
  pullRequestCanHavePreviewApp,
} from "./pullRequestPreviewApp.logic";

const state = (overrides: Partial<DesktopPreviewAppState> = {}): DesktopPreviewAppState => ({
  supported: true,
  installed: null,
  opensAfterInstall: true,
  canInstall: true,
  canOpen: false,
  canRemove: false,
  canReset: false,
  activity: { status: "idle" },
  ...overrides,
});
const build = (runNumber: number): DesktopPreviewAppBuild => ({
  pullRequestNumber: 12,
  runNumber,
  version: `1.2.3-pr.12.${runNumber}`,
  sizeBytes: 1,
  publishedAt: "2026-11-05T10:00:00Z",
});
const installed = (pullRequestNumber: number, runNumber: number) => ({
  version: `1.2.3-pr.${pullRequestNumber}.${runNumber}`,
  pullRequestNumber,
  runNumber,
});

describe("previewAppControlView", () => {
  it.each([
    ["no desktop state", null, null, false, "hidden"],
    ["an unsupported Mac", state({ supported: false }), build(7), false, "hidden"],
    ["no build, nothing running", state(), null, false, "hidden"],
    ["no build yet, one running", state(), null, true, "building"],
    ["a build, nothing installed", state(), build(7), false, "install"],
    [
      "a newer build of this pull request",
      state({ installed: installed(12, 6), canOpen: true }),
      build(7),
      false,
      "install",
    ],
    [
      "another pull request installed",
      state({ installed: installed(99, 1), canOpen: true }),
      build(7),
      false,
      "install",
    ],
    [
      "this build already installed",
      state({ installed: installed(12, 7), canOpen: true }),
      build(7),
      false,
      "open",
    ],
    [
      "installed, its asset deleted",
      state({ installed: installed(12, 7), canOpen: true }),
      null,
      false,
      "open",
    ],
    [
      "a preview running from the install location",
      state({ canInstall: false, installed: installed(12, 6) }),
      build(7),
      false,
      "open",
    ],
  ] as const)("%s", (_name, inputState, inputBuild, buildRunning, kind) => {
    expect(
      previewAppControlView({
        pullRequestNumber: 12,
        state: inputState,
        build: inputBuild,
        buildRunning,
        lookupFailed: false,
      }).kind,
    ).toBe(kind);
  });

  it("says what is replaced and that a newer build is on its way", () => {
    const view = previewAppControlView({
      pullRequestNumber: 12,
      state: state({ installed: installed(99, 1) }),
      build: build(7),
      buildRunning: true,
      lookupFailed: false,
    });
    expect(view).toMatchObject({
      kind: "install",
      label: "Install and open",
      replaces: { pullRequestNumber: 99 },
      newerBuildRunning: true,
    });
  });

  it("offers only Install in a preview app, which cannot open another copy of itself", () => {
    const view = previewAppControlView({
      pullRequestNumber: 12,
      state: state({ opensAfterInstall: false }),
      build: build(7),
      buildRunning: false,
      lookupFailed: false,
    });
    expect(view).toMatchObject({ label: "Install" });
  });

  it.each([
    ["confirming", null, "Waiting for confirmation…", false],
    ["downloading", 42, "Downloading 42%", true],
    ["copying", null, "Copying…", true],
    ["quitting", null, "Quitting preview…", true],
    ["opening", null, "Opening…", false],
  ] as const)("shows the %s phase", (phase, progress, label, canCancel) => {
    expect(
      previewAppControlView({
        pullRequestNumber: 12,
        state: state({
          activity: { status: "installing", pullRequestNumber: 12, phase, progress },
        }),
        build: build(7),
        buildRunning: false,
        lookupFailed: false,
      }),
    ).toEqual({ kind: "busy", label, canCancel });
  });

  it("says when GitHub did not answer, but a known build still wins", () => {
    const view = (inputBuild: DesktopPreviewAppBuild | null) =>
      previewAppControlView({
        pullRequestNumber: 12,
        state: state(),
        build: inputBuild,
        buildRunning: false,
        lookupFailed: true,
      }).kind;
    expect(view(null)).toBe("lookup-failed");
    expect(view(build(7))).toBe("install");
  });

  it("does not offer another pull request's install for cancelling here", () => {
    expect(
      previewAppControlView({
        pullRequestNumber: 12,
        state: state({
          activity: {
            status: "installing",
            pullRequestNumber: 99,
            phase: "copying",
            progress: null,
          },
        }),
        build: build(7),
        buildRunning: false,
        lookupFailed: false,
      }),
    ).toEqual({ kind: "busy", label: "Installing #99", canCancel: false });
  });
});

describe("pullRequestCanHavePreviewApp", () => {
  const labels = [{ name: "preview:mac", color: null }];
  it.each([
    ["github", "incognitojam/styal", labels, true],
    ["github", "IncognitoJam/Styal", labels, true],
    ["github", "someone/fork", labels, false],
    ["github", "incognitojam/styal", [], false],
    ["gitlab", "incognitojam/styal", labels, false],
  ] as const)("%s %s", (provider, repository, prLabels, expected) => {
    expect(
      pullRequestCanHavePreviewApp(
        { provider: provider as PullRequestDetail["provider"], labels: [...prLabels] },
        repository,
      ),
    ).toBe(expected);
  });
});

describe("previewBuildIsRunning", () => {
  const check = (name: string, status: "pending" | "success") => ({
    name,
    status,
    description: null,
    url: null,
  });
  it("looks only at the preview workflow's own jobs", () => {
    expect(
      previewBuildIsRunning({ checks: [check("Build macOS Apple Silicon preview", "pending")] }),
    ).toBe(true);
    expect(
      previewBuildIsRunning({ checks: [check("Build macOS Apple Silicon preview", "success")] }),
    ).toBe(false);
    expect(previewBuildIsRunning({ checks: [check("Lint", "pending")] })).toBe(false);
  });
});
