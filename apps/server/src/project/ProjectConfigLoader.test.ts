import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectConfigLoader from "./ProjectConfigLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(ProjectConfigLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "styal-project-config-",
  });
});

const writeFile = Effect.fn("writeFile")(function* (
  cwd: string,
  name: "styal.json" | "t3.json",
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, name), contents).pipe(Effect.orDie);
});

it.layer(layerTest)("ProjectConfigLoader", (it) => {
  describe("load", () => {
    it.effect("loads styal.json, comments included, and ignores t3.json", () =>
      Effect.gen(function* () {
        const loader = yield* ProjectConfigLoader.ProjectConfigLoader;
        const cwd = yield* makeTempDir;
        yield* writeFile(
          cwd,
          "styal.json",
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "actions": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );
        yield* writeFile(
          cwd,
          "t3.json",
          `{ "iconPath": "t3.svg", "defaultThreadEnvMode": "local" }`,
        );

        expect(yield* loader.load(cwd)).toEqual({
          status: "valid",
          source: "styal.json",
          config: {
            source: "styal.json",
            iconPath: "assets/logo.svg",
            actions: [{ id: "dev", name: "Dev", command: "pnpm dev", icon: "play" }],
          },
          legacyScripts: [],
        });
      }),
    );

    it.effect("falls back to t3.json settings when styal.json is missing", () =>
      Effect.gen(function* () {
        const loader = yield* ProjectConfigLoader.ProjectConfigLoader;
        const cwd = yield* makeTempDir;
        yield* writeFile(
          cwd,
          "t3.json",
          `{ "iconPath": "t3.svg", "scripts": [{ "name": "Dev", "command": "pnpm dev" }] }`,
        );

        expect(yield* loader.load(cwd)).toEqual({
          status: "valid",
          source: "t3.json",
          config: { source: "t3.json", iconPath: "t3.svg", actions: [] },
          legacyScripts: [{ name: "Dev", command: "pnpm dev" }],
        });
      }),
    );

    it.effect("is missing when neither file exists", () =>
      Effect.gen(function* () {
        const loader = yield* ProjectConfigLoader.ProjectConfigLoader;
        const cwd = yield* makeTempDir;

        expect((yield* loader.load(cwd)).status).toBe("missing");
      }),
    );

    it.effect("is invalid for a malformed styal.json without falling back or failing", () =>
      Effect.gen(function* () {
        const loader = yield* ProjectConfigLoader.ProjectConfigLoader;
        const cwd = yield* makeTempDir;
        yield* writeFile(cwd, "styal.json", "{ not json");
        yield* writeFile(cwd, "t3.json", `{ "iconPath": "t3.svg" }`);

        expect(yield* loader.load(cwd)).toEqual({
          status: "invalid",
          source: "styal.json",
          config: null,
          legacyScripts: [],
        });
      }),
    );

    it.effect("keeps valid fields and actions from a partially invalid file", () =>
      Effect.gen(function* () {
        const loader = yield* ProjectConfigLoader.ProjectConfigLoader;
        const cwd = yield* makeTempDir;
        yield* writeFile(
          cwd,
          "styal.json",
          `{
            "iconPath": "assets/logo.svg",
            "defaultThreadEnvMode": "spaceship",
            "actions": [
              { "name": "Dev", "command": "pnpm dev", "icon": "spaceship" },
              { "name": "Broken" },
              { "name": "Test", "command": "pnpm test", "icon": "test" }
            ]
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(loaded.status).toBe("partial");
        expect(loaded.config).toEqual({
          source: "styal.json",
          iconPath: "assets/logo.svg",
          actions: [
            { id: "dev", name: "Dev", command: "pnpm dev", icon: "play" },
            { id: "test", name: "Test", command: "pnpm test", icon: "test" },
          ],
        });
      }),
    );
  });
});
