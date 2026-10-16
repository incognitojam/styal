import { expect, it } from "vite-plus/test";
import { resolveBuildContext } from "./BuildContext.ts";

it.each([
  ["0.2.0", "stable"],
  ["0.2.1-nightly.20261015.1", "nightly"],
  ["0.0.45-pr.123.1", "preview"],
  ["0.2.1-preview.20261015.1", "preview"],
  ["custom-build", "unknown"],
] as const)("classifies release build %s as %s", (version, releaseChannel) => {
  expect(
    resolveBuildContext({
      version,
      releaseBuild: true,
      developmentServer: false,
      testProcess: false,
    }),
  ).toEqual({ buildKind: "release", releaseChannel });
});

it("keeps source, dev-server and test runs separate even when they use a release version", () => {
  const base = {
    version: "0.2.0",
    releaseBuild: true,
    developmentServer: false,
    testProcess: false,
  };
  expect(resolveBuildContext({ ...base, releaseBuild: false })).toEqual({
    buildKind: "development",
    releaseChannel: "unknown",
  });
  expect(resolveBuildContext({ ...base, developmentServer: true })).toEqual({
    buildKind: "development",
    releaseChannel: "unknown",
  });
  expect(resolveBuildContext({ ...base, testProcess: true })).toEqual({
    buildKind: "test",
    releaseChannel: "unknown",
  });
});
