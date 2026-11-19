import { describe, expect, it } from "vite-plus/test";

import { explainerOpening, firstSceneStep, nextSceneStep } from "./featureExplainer.logic";

describe("explainerOpening", () => {
  it("opens once when the feature is first turned on, then never by itself again", () => {
    const first = explainerOpening([], "worktree-source-checkout", "enabled");
    expect(first).toEqual({ open: true, seen: ["worktree-source-checkout"] });

    const second = explainerOpening(first.seen, "worktree-source-checkout", "enabled");
    expect(second).toEqual({ open: false, seen: ["worktree-source-checkout"] });
  });

  it("always opens from the link, and a viewing from the link counts as seen", () => {
    const fromLink = explainerOpening([], "worktree-source-checkout", "link");
    expect(fromLink).toEqual({ open: true, seen: ["worktree-source-checkout"] });
    expect(explainerOpening(fromLink.seen, "worktree-source-checkout", "link").open).toBe(true);
    expect(explainerOpening(fromLink.seen, "worktree-source-checkout", "enabled").open).toBe(false);
  });

  it("tracks each feature separately", () => {
    expect(
      explainerOpening(["worktree-source-checkout"], "project-coordinators", "enabled"),
    ).toEqual({ open: true, seen: ["worktree-source-checkout", "project-coordinators"] });
  });
});

describe("scene playback", () => {
  it("plays from the first frame and stops on the last", () => {
    expect(firstSceneStep(3, false)).toBe(0);
    expect(nextSceneStep(0, 3)).toBe(1);
    expect(nextSceneStep(1, 3)).toBe(2);
    expect(nextSceneStep(2, 3)).toBeNull();
    expect(nextSceneStep(0, 1)).toBeNull();
  });

  it("shows only the last frame under reduced motion", () => {
    expect(firstSceneStep(3, true)).toBe(2);
    expect(nextSceneStep(firstSceneStep(3, true), 3)).toBeNull();
  });
});
