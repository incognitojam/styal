import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.styal/dev");
      assert.equal(production.stateDir, "/Users/alice/.styal/userdata");
    }),
  );

  it.effect("keeps the credential storage name stable across release stages", () =>
    Effect.gen(function* () {
      const stable = yield* makeEnvironment({ appVersion: "0.0.22" });
      const nightly = yield* makeEnvironment({ appVersion: "0.0.22-nightly.20260823.1" });
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );

      // Stable and Nightly share a bundle id and a user-data directory, so they
      // have to share the credential namespace guarding that state. Development
      // keeps its own, matching its separate state directory.
      assert.equal(stable.safeStorageName, "styal");
      assert.equal(nightly.safeStorageName, "styal");
      assert.equal(stable.stateDir, nightly.stateDir);
      assert.equal(development.safeStorageName, "styal-dev");

      // Branding still tracks the stage.
      assert.equal(stable.displayName, "styal");
      assert.equal(nightly.displayName, "styal (Nightly)");
    }),
  );

  it.effect("installs pull request previews beside stable with their own state", () =>
    Effect.gen(function* () {
      const preview = yield* makeEnvironment({ appVersion: "0.0.22-pr.456.437" });
      // A preview is its own home inside the styal home, so the local server it
      // starts keeps its database there too. An explicit home does not change that.
      const previewWithHome = yield* makeEnvironment(
        { appVersion: "0.0.22-pr.456.437" },
        { STYAL_HOME: "/tmp/styal" },
      );

      assert.equal(preview.installVariant, "preview");
      assert.equal(preview.displayName, "styal (Preview)");
      assert.equal(preview.baseDir, "/Users/alice/.styal/preview");
      assert.equal(preview.stateDir, "/Users/alice/.styal/preview/userdata");
      assert.equal(previewWithHome.baseDir, "/tmp/styal/preview");
      assert.equal(previewWithHome.stateDir, "/tmp/styal/preview/userdata");
      assert.equal(preview.safeStorageName, "styal-preview");
      assert.equal(preview.appUserModelId, "build.styal.app.preview");
      assert.equal(preview.linuxDesktopEntryName, "build.styal.Styal.Preview.desktop");
      assert.equal(preview.linuxWmClass, "styal-preview");
    }),
  );
});
