import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Preferences } from "../../persistence/imperative";

const harness = vi.hoisted(() => ({
  preferences: {} as Preferences,
  updateId: "update-a" as string | null,
}));

vi.mock("expo-updates", () => ({
  get updateId() {
    return harness.updateId;
  },
}));

vi.mock("../../persistence/imperative", () => ({
  loadPreferences: async () => harness.preferences,
  updatePreferences: async (transform: (current: Preferences) => Partial<Preferences>) => {
    harness.preferences = JSON.parse(
      JSON.stringify({ ...harness.preferences, ...transform(harness.preferences) }),
    );
    return harness.preferences;
  },
}));

import {
  saveUpdateRestartLocation,
  setCurrentWorkspacePath,
  takeUpdateRestartPath,
} from "./update-restart-location";

describe("update restart location", () => {
  beforeEach(() => {
    harness.preferences = { baseFontSize: 17 };
    harness.updateId = "update-a";
  });

  it("reopens the page the user was on once the restart runs the new update", async () => {
    setCurrentWorkspacePath("/threads/environment-1/thread-1");
    await saveUpdateRestartLocation();

    harness.updateId = "update-b";
    expect(await takeUpdateRestartPath()).toBe("/threads/environment-1/thread-1");
    // One-shot: a later launch on the same update starts normally.
    expect(await takeUpdateRestartPath()).toBeNull();
    expect(harness.preferences).toEqual({ baseFontSize: 17 });
  });

  it("drops the location when the restart did not change the running update", async () => {
    setCurrentWorkspacePath("/threads/environment-1/thread-1");
    await saveUpdateRestartLocation();

    expect(await takeUpdateRestartPath()).toBeNull();
    harness.updateId = "update-b";
    expect(await takeUpdateRestartPath()).toBeNull();
  });

  it("saves nothing while the user is on Home", async () => {
    setCurrentWorkspacePath("/");
    await saveUpdateRestartLocation();

    expect(harness.preferences).toEqual({ baseFontSize: 17 });
  });
});
