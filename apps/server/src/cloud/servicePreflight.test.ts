import { expect, it } from "@effect/vitest";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it("requires the styal package launcher protocol", () => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL - 1,
      version: "1.2.3",
    }),
  ).toMatchObject({ status: "blocked", version: "1.2.3" });

  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "ready",
    version: "1.2.3",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
  });
});

it.each([1])("blocks legacy launcher protocol %i with exact recovery steps", (launcherProtocol) => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol,
    version: "9.8.7",
  });

  expect(result).toMatchObject({ status: "blocked", version: "9.8.7" });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toMatch(new RegExp(`\\b${launcherProtocol}\\b`));
  expect(reason).toMatch(new RegExp(`\\b${SERVICE_LAUNCHER_PROTOCOL}\\b`));
  expect(reason).toContain("npx @styal/cli@9.8.7 service update");
  expect(reason).toContain("styal service update");
  expect(reason).toContain("styal --version");
  expect(reason).toContain("which -a styal");
});
