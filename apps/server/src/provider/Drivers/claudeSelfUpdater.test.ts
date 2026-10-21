// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as NodePath from "node:path";

import {
  claudeSelfUpdaterActive,
  claudeUpdaterActive,
  handBackClaudeSelfUpdater,
  turnOffClaudeSelfUpdater,
} from "./claudeSelfUpdater.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

// What `claude install <version>` leaves in `.claude.json`.
const PINNED_CONFIG = {
  installMethod: "native",
  autoUpdates: false,
  autoUpdatesProtectedForNative: true,
};

describe("claudeUpdaterActive", () => {
  it("follows Claude's own check", () => {
    const active = (
      env: NodeJS.ProcessEnv,
      settings: unknown = {},
      config: unknown = PINNED_CONFIG,
    ) => claudeUpdaterActive({ env, settings, config });
    // Protected native installs ignore `autoUpdates: false`.
    expect(active({})).toBe(true);
    expect(active({}, {}, { ...PINNED_CONFIG, autoUpdatesProtectedForNative: false })).toBe(false);
    expect(active({ DISABLE_AUTOUPDATER: "1" })).toBe(false);
    expect(active({}, { env: { DISABLE_AUTOUPDATER: "true" } })).toBe(false);
    // Claude reads only 1/true/yes/on as set, so "0" leaves it on, but by the user's choice.
    expect(active({}, { env: { DISABLE_AUTOUPDATER: "0" } })).toBe(null);
    expect(active({}, { env: { DISABLE_AUTOUPDATER: "0", STYAL_MANAGED_UPDATES: "1" } })).toBe(
      true,
    );
    expect(active({}, { env: { DISABLE_UPDATES: "x" } })).toBe(false);
    expect(active({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })).toBe(false);
    expect(active({}, { env: [] })).toBe(null);
    expect(active({}, "not an object")).toBe(null);
  });
});

const withClaudeHome = (
  body: (input: {
    readonly paths: { readonly configDir: string; readonly accountConfigPath: string };
    readonly settingsPath: string;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "styal-claude-updater-" });
    const configDir = NodePath.join(root, ".claude");
    yield* fs.makeDirectory(configDir);
    const accountConfigPath = NodePath.join(root, ".claude.json");
    yield* fs.writeFileString(accountConfigPath, JSON.stringify(PINNED_CONFIG));
    return yield* body({
      paths: { configDir, accountConfigPath },
      settingsPath: NodePath.join(configDir, "settings.json"),
      fs,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("turning native Claude Code's own updater off and back on", () => {
  it.effect.skipIf(windowsHost)("adds the variable and keeps every other setting", () =>
    withClaudeHome(({ paths, settingsPath, fs }) =>
      Effect.gen(function* () {
        const original = {
          model: "opus",
          env: { ANTHROPIC_BASE_URL: "https://proxy.invalid" },
          permissions: { allow: ["Bash(ls:*)"] },
        };
        yield* fs.writeFileString(settingsPath, `${JSON.stringify(original, null, 4)}\n`);
        yield* fs.chmod(settingsPath, 0o600);

        yield* turnOffClaudeSelfUpdater(paths, {});
        const text = yield* fs.readFileString(settingsPath);
        expect(JSON.parse(text)).toEqual({
          ...original,
          env: { ...original.env, DISABLE_AUTOUPDATER: "1", STYAL_MANAGED_UPDATES: "1" },
        });
        // Same key order, same private permissions.
        expect(Object.keys(JSON.parse(text))).toEqual(["model", "env", "permissions"]);
        expect((yield* fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
        expect(yield* claudeSelfUpdaterActive(paths, {})).toBe(false);

        yield* handBackClaudeSelfUpdater(paths);
        expect(JSON.parse(yield* fs.readFileString(settingsPath))).toEqual(original);
        expect(yield* claudeSelfUpdaterActive(paths, {})).toBe(true);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("creates the settings file and writes through a symlink", () =>
    withClaudeHome(({ paths, settingsPath, fs }) =>
      Effect.gen(function* () {
        yield* turnOffClaudeSelfUpdater(paths, {});
        expect(JSON.parse(yield* fs.readFileString(settingsPath))).toEqual({
          env: { DISABLE_AUTOUPDATER: "1", STYAL_MANAGED_UPDATES: "1" },
        });

        // A dotfiles checkout links settings.json; the link must survive.
        const target = NodePath.join(paths.configDir, "dotfiles-settings.json");
        yield* fs.rename(settingsPath, target);
        yield* fs.symlink(target, settingsPath);
        yield* handBackClaudeSelfUpdater(paths);
        expect(yield* fs.readLink(settingsPath)).toBe(target);
        expect(JSON.parse(yield* fs.readFileString(target))).toEqual({ env: {} });
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("never rewrites a file it cannot parse", () =>
    withClaudeHome(({ paths, settingsPath, fs }) =>
      Effect.gen(function* () {
        const broken = '{ "model": "opus", // a comment\n}';
        yield* fs.writeFileString(settingsPath, broken);
        expect(yield* claudeSelfUpdaterActive(paths, {})).toBe(null);
        yield* turnOffClaudeSelfUpdater(paths, {});
        yield* handBackClaudeSelfUpdater(paths);
        expect(yield* fs.readFileString(settingsPath)).toBe(broken);
      }),
    ),
  );

  it.effect.skipIf(windowsHost)("leaves the user's own choice alone", () =>
    withClaudeHome(({ paths, settingsPath, fs }) =>
      Effect.gen(function* () {
        const write = (settings: unknown) =>
          fs.writeFileString(settingsPath, JSON.stringify(settings));
        const read = Effect.map(fs.readFileString(settingsPath), (text) => JSON.parse(text));

        // Set by the user, on or off: styal neither adds nor removes it.
        for (const value of ["1", "0"]) {
          yield* write({ env: { DISABLE_AUTOUPDATER: value } });
          yield* turnOffClaudeSelfUpdater(paths, {});
          yield* handBackClaudeSelfUpdater(paths);
          expect(yield* read).toEqual({ env: { DISABLE_AUTOUPDATER: value } });
        }

        // Already off another way: nothing to take over.
        yield* write({ env: { DISABLE_UPDATES: "1" } });
        yield* turnOffClaudeSelfUpdater(paths, {});
        expect(yield* read).toEqual({ env: { DISABLE_UPDATES: "1" } });

        // The user changed styal's value since: hand-back drops only styal's record.
        yield* write({ env: { DISABLE_AUTOUPDATER: "true", STYAL_MANAGED_UPDATES: "1" } });
        yield* handBackClaudeSelfUpdater(paths);
        expect(yield* read).toEqual({ env: { DISABLE_AUTOUPDATER: "true" } });
      }),
    ),
  );
});
