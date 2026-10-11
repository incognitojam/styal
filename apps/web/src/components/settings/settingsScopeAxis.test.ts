import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  selectSingleEnvironmentScope,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";
import { resolveSettingsScope } from "./settingsScope";

const first = {
  environmentId: EnvironmentId.make("first"),
  label: "Development",
  displayUrl: "https://first.example.com",
};
const second = {
  environmentId: EnvironmentId.make("second"),
  label: "Development",
  displayUrl: "https://second.example.com",
};

describe("settings scope environment labels", () => {
  it("distinguishes same-name environments by address", () => {
    const environments = [first, second];
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual([
      "Development · https://first.example.com",
      "Development · https://second.example.com",
    ]);
  });

  it("falls back to environment IDs when duplicate names have no display URL", () => {
    const environments = [first, second].map((environment) => ({
      ...environment,
      displayUrl: null,
    }));
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual(["Development · first", "Development · second"]);
  });

  it("keeps unique names compact and removes disambiguation after a rename", () => {
    expect(settingsScopeEnvironmentLabel(first, [first])).toBe("Development");
    expect(settingsScopeEnvironmentLabel(first, [first, { ...second, label: "Production" }])).toBe(
      "Development",
    );
  });
});

describe("settings scope axes", () => {
  it("maps each axis to its search key and back", () => {
    expect(projectAxisValue({})).toBe("all");
    expect(projectAxisValue({ project: "app" })).toBe("app");
    expect(selectProjectAxis({ machine: "second" }, "app")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis({ machine: "second", project: "app" }, "all")).toEqual({
      machine: "second",
    });
    expect(selectEnvironmentAxis({ project: "app" }, "first")).toEqual({
      project: "app",
      machine: "first",
    });
    expect(selectEnvironmentAxis({ project: "app", machine: "first" }, "all")).toEqual({
      project: "app",
    });
  });

  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });
});

describe("environmentAxisValue", () => {
  it("shows the checkout's environment for a legacy checkout link", () => {
    expect(environmentAxisValue({ project: "p", checkout: "c" }, "laptop")).toBe("laptop");
    expect(environmentAxisValue({ project: "p" }, null)).toBe("all");
    expect(environmentAxisValue({ machine: "desk" }, "laptop")).toBe("desk");
  });
});

describe("provider environment scope", () => {
  const environments = [first, second].map((environment) => ({
    ...environment,
    connection: { phase: "connected" as const },
  }));

  it("drops inherited project and checkout filters while retaining the selected environment", () => {
    const search = { project: "removed-project", checkout: "old-checkout", machine: "second" };
    const next = selectSingleEnvironmentScope(
      search,
      resolveSettingsScope(search, [], environments),
      environments,
      first.environmentId,
    );
    expect(next).toEqual({ machine: "second" });
    expect(resolveSettingsScope(next, [], environments)).toMatchObject({
      kind: "environment",
      environmentId: second.environmentId,
      members: [],
    });
  });

  it("does not let an unavailable project prevent opening the primary environment's providers", () => {
    const search = { project: "removed-project" };
    const next = selectSingleEnvironmentScope(
      search,
      resolveSettingsScope(search, [], environments),
      environments,
      second.environmentId,
    );
    expect(next).toEqual({ machine: "second" });
    expect(resolveSettingsScope(next, [], environments).kind).toBe("environment");
  });

  it("keeps a removed environment unavailable rather than choosing another machine", () => {
    const search = { project: "old-project", machine: "removed-environment" };
    const next = selectSingleEnvironmentScope(
      search,
      resolveSettingsScope(search, [], environments),
      environments,
      first.environmentId,
    );
    expect(next).toEqual({ machine: "removed-environment" });
    expect(resolveSettingsScope(next, [], environments)).toMatchObject({
      kind: "unavailable",
      reason: "environment-missing",
    });
  });

  it("chooses a connected environment when the primary environment is absent", () => {
    const candidates = [
      { ...environments[0]!, connection: { phase: "offline" as const } },
      environments[1]!,
    ];
    expect(
      selectSingleEnvironmentScope({}, resolveSettingsScope({}, [], candidates), candidates, null),
    ).toEqual({ machine: "second" });
  });

  it("leaves the environment unselected when none are available", () => {
    const search = { project: "old-project" };
    expect(
      selectSingleEnvironmentScope(search, resolveSettingsScope(search, [], []), [], null),
    ).toEqual({});
  });
});
