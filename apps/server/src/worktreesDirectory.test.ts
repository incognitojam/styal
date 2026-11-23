import { it, expect } from "@effect/vitest";
import { ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as NodeServices from "./nodeServices.ts";
import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";
import { isWithinWorktreesDirectory, makeManagedWorktreeBoundary } from "./worktreesDirectory.ts";

it.effect.each([
  { candidate: "/volume/managed/Repo", insensitive: true, expected: true },
  { candidate: "/volume/managed/Repo", insensitive: false, expected: false },
  { candidate: "/Volume/Managed", insensitive: false, expected: true },
  { candidate: "/Volume/Managed-other/Repo", insensitive: true, expected: false },
  { candidate: "/Volume", insensitive: true, expected: false },
])(
  "compares canonical paths with the volume's case rule: %s",
  ({ candidate, insensitive, expected }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(isWithinWorktreesDirectory(path, "/Volume/Managed", candidate, insensitive)).toBe(
        expected,
      );
    }).pipe(Effect.provide(Path.layer)),
);

it.effect("settings failures affect only default or previously known worktree folders", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "worktree-boundary-" }),
    );
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettings.ServerSettingsService;
      const failing = yield* Ref.make(false);
      const boundaryFor = yield* makeManagedWorktreeBoundary.pipe(
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...settings,
          getSettings: Ref.get(failing).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(
                    new ServerSettingsError({
                      settingsPath: "/synthetic/settings.json",
                      operation: "read-file",
                    }),
                  )
                : settings.getSettings,
            ),
          ),
        }),
      );
      expect((yield* boundaryFor(`${base}/custom/project/topic`))?.directory).toBe(
        `${base}/custom`,
      );
      yield* Ref.set(failing, true);
      expect(yield* boundaryFor(`${base}/ordinary/project`)).toBeNull();
      expect((yield* boundaryFor(`${base}/custom/project/topic`).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* boundaryFor(`${config.worktreesDir}/project/topic`).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(base, base),
          ServerSettings.layerTest({ worktreesDirectory: `${base}/custom` }),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
