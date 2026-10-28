import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const reportForkClientUsage = vi.hoisted(() => vi.fn());
vi.mock("./forkClientUsage", () => ({ reportForkClientUsage }));
vi.mock("./rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => "environment-primary" } }));
vi.mock("./state/primaryEnvironment", () => ({
  primaryEnvironmentIdAtom: "primary-environment-atom",
}));

import {
  reportNewThreadWhileFiltered,
  setSidebarProjectFilterFromUser,
} from "./sidebarProjectFilterUsage";
import { useUiStateStore } from "./uiStateStore";

describe("sidebar project filter usage", () => {
  beforeEach(() => {
    reportForkClientUsage.mockReset();
    useUiStateStore.getState().setSidebarProjectScopeKeys([]);
  });

  it("applies a user's filter choice and reports only the kind of change", async () => {
    await setSidebarProjectFilterFromUser(["environment-a:project-synthetic"], "filter_menu");
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([
      "environment-a:project-synthetic",
    ]);
    await setSidebarProjectFilterFromUser([], "thread_menu");
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([]);

    expect(reportForkClientUsage.mock.calls).toEqual([
      [
        "environment-primary",
        { feature: "sidebar-project-filter", action: "filter_set", entryPoint: "filter_menu" },
      ],
      [
        "environment-primary",
        { feature: "sidebar-project-filter", action: "filter_cleared", entryPoint: "thread_menu" },
      ],
    ]);
  });

  it("does not count picking the filter that is already applied", async () => {
    await setSidebarProjectFilterFromUser([], "filter_menu");
    await setSidebarProjectFilterFromUser(["environment-a:project-synthetic"], "project_menu");
    await setSidebarProjectFilterFromUser(["environment-a:project-synthetic"], "filter_menu");
    expect(reportForkClientUsage).toHaveBeenCalledTimes(1);
  });

  it("counts each change to a filter on several projects as a filter set", async () => {
    await setSidebarProjectFilterFromUser(["environment-a:project-one"], "filter_menu");
    await setSidebarProjectFilterFromUser(
      ["environment-a:project-one", "environment-a:project-two"],
      "filter_menu",
    );
    await setSidebarProjectFilterFromUser(["environment-a:project-two"], "filter_menu");

    expect(reportForkClientUsage.mock.calls.map(([, input]) => input.action)).toEqual([
      "filter_set",
      "filter_set",
      "filter_set",
    ]);
  });

  it("counts new threads only while a filter is applied", async () => {
    await reportNewThreadWhileFiltered();
    expect(reportForkClientUsage).not.toHaveBeenCalled();

    useUiStateStore.getState().setSidebarProjectScopeKeys(["environment-a:project-synthetic"]);
    await reportNewThreadWhileFiltered();
    expect(reportForkClientUsage).toHaveBeenCalledWith("environment-primary", {
      feature: "sidebar-project-filter",
      action: "thread_started",
    });
  });
});
